/** SyncPair: self-hosted music library + real-time listening synchronization. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ROOT = __dirname;
// Set DATA_DIR to a persistent volume mount (for example /var/data on Render).
// Keep uploaded audio and data.json outside the ephemeral application filesystem.
const DATA_DIR = process.env.DATA_DIR || ROOT;
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { users: [], tracks: [] }; }
}
const persisted = loadData();
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
// Store only token hashes on disk; migrate legacy plaintext tokens transparently.
const users = new Map((persisted.users || []).map(u => { const migrated = { ...u, tokenHash: u.tokenHash || (u.token ? tokenHash(u.token) : null), online: false }; delete migrated.token; return [u.id, migrated]; }));
function userForToken(token) { const hash = tokenHash(token || ''); return [...users.values()].find(u => u.tokenHash && crypto.timingSafeEqual(Buffer.from(u.tokenHash), Buffer.from(hash))); }
const tracks = new Map((persisted.tracks || []).map(t => [t.id, t]));
const pairs = new Map(Object.entries(persisted.pairs || {})); // shared favorites + playlists per couple
// Persist the token-hash migration immediately, so legacy plaintext credentials are not left on disk.
saveData();
// Migration: tracks uploaded before libraries were scoped to a pair have no owner. Give them to the first
// paired account (the couple that was using the server) so they stay visible to that pair and to nobody else.
{
  const orphan = [...tracks.values()].filter(t => !t.uploadedBy);
  const owner = [...users.values()].find(u => u.partnerId);
  if (orphan.length && owner) { orphan.forEach(t => { t.uploadedBy = owner.id; }); console.log(`Assigned ${orphan.length} legacy track(s) to ${owner.name}'s pair.`); }
}
const states = new Map();
const sessions = new Map();
function saveData() {
  const safeUsers = [...users.values()].map(({ online, _pairFails, token, ...u }) => u);
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: safeUsers, tracks: [...tracks.values()], pairs: Object.fromEntries(pairs) }, null, 2));
}
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(express.json({ limit: '1mb' }));

// Bearer-token auth for library endpoints (same token the socket uses).
function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const u = m && userForToken(m[1]);
  if (!u) return res.status(401).json({ error: 'Sign in again.' });
  req.user = u; next();
}
// Tiny in-memory rate limiter: `max` hits per `windowMs` per key.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip, now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    arr.push(now); hits.set(key, arr); next();
  };
}
app.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));
app.get('/api/library', requireAuth, (req, res) => res.json([...tracks.values()].filter(t => canSee(req.user.id, t)).map(pubTrack)));
app.post('/api/library', rateLimit(12, 60 * 60 * 1000), requireAuth, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Choose a non-empty audio file.' });
  if (req.body.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'Audio files must be 50 MB or smaller.' });
  const pairStorage = [...tracks.values()].filter(t => canSee(req.user.id, t)).reduce((n, t) => n + (Number(t.size) || 0), 0);
  if (pairStorage + req.body.length > 250 * 1024 * 1024) return res.status(413).json({ error: 'This shared library has reached its 250 MB storage limit.' });
  const decodeHeader = value => { try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); } };
  const originalName = decodeHeader(req.headers['x-file-name'] || 'audio').replace(/[\\/\0]/g, '').slice(0, 160);
  const ext = path.extname(originalName).toLowerCase();
  const allowed = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.opus', '.webm']);
  if (!allowed.has(ext)) return res.status(415).json({ error: 'Unsupported format. Use MP3, WAV, M4A, AAC, OGG, FLAC, OPUS or WEBM.' });
  const hash = crypto.createHash('sha256').update(req.body).digest('hex');
  // Only dedupe against this pair's own library, never against another pair's files.
  const dup = [...tracks.values()].find(t => t.hash === hash && canSee(req.user.id, t));
  if (dup) return res.status(200).json(pubTrack(dup)); // same audio already in the library
  const id = crypto.randomUUID();
  const fileName = id + ext;
  fs.writeFileSync(path.join(MUSIC_DIR, fileName), req.body, { flag: 'wx' });
  const fallbackTitle = path.basename(originalName, ext).slice(0, 100) || 'Untitled';
  const track = {
    id,
    title: (decodeHeader(req.headers['x-track-title']) || fallbackTitle).slice(0, 100),
    artist: (decodeHeader(req.headers['x-track-artist']) || 'Unknown artist').slice(0, 100),
    durationMs: Math.max(0, Number(req.headers['x-track-duration-ms']) || 0),
    url: '/music/' + fileName,
    fileName: originalName,
    size: req.body.length,
    hash,
    uploadedBy: req.user.id,
  };
  tracks.set(id, track);
  saveData();
  res.status(201).json(pubTrack(track));
});
// Audio files require the account token (?t=… because <audio> cannot send headers) and are served only to
// the uploader and their partner. Supports Range requests so seeking works.
app.get('/music/:file', (req, res) => {
  const header = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const token = String(req.query.t || (header && header[1]) || '');
  const user = token && userForToken(token);
  const file = req.params.file;
  const track = /^[\w-]+\.\w+$/.test(file) ? [...tracks.values()].find(t => t.url === '/music/' + file) : null;
  if (!user || !canSee(user.id, track)) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(MUSIC_DIR, file), err => { if (err && !res.headersSent) res.status(404).json({ error: 'Not found.' }); });
});
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(ROOT, 'app.js')));
app.get('/embed.html', (_req, res) => res.sendFile(path.join(ROOT, 'embed.html')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(ROOT, 'style.css')));
const server = http.createServer(app);
const io = new Server(server);
const rand = (n = 6) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n).toUpperCase();
const publicUser = u => ({ id: u.id, name: u.name, online: !!u.online });
const partnerOf = uid => { const u = users.get(uid); return u?.partnerId ? users.get(u.partnerId) : null; };
// A library track belongs to the account that uploaded it and is shared with that account's partner only.
const canSee = (uid, t) => !!t && !!t.uploadedBy && (t.uploadedBy === uid || partnerOf(uid)?.id === t.uploadedBy);
const visibleTrack = (uid, id) => { const t = id ? tracks.get(String(id)) : null; return canSee(uid, t) ? t : null; };
const pubTrack = t => { if (!t) return t; const { hash, uploadedBy, ...pub } = t; return pub; };
// ---- Shared links ----
// YouTube, Spotify and SoundCloud play through each phone's own embedded player (synced, nothing downloaded);
// direct audio URLs play natively; Apple Music, Deezer, Tidal... have no playback API, so they get a shared
// clock + "open in app" (each person presses play in their own app).
const OTHER_APPS = { 'music.apple.com': 'Apple Music', 'itunes.apple.com': 'Apple Music', 'deezer.com': 'Deezer', 'deezer.page.link': 'Deezer', 'tidal.com': 'Tidal', 'listen.tidal.com': 'Tidal', 'music.amazon.com': 'Amazon Music', 'music.amazon.fr': 'Amazon Music', 'napster.com': 'Napster', 'qobuz.com': 'Qobuz', 'play.qobuz.com': 'Qobuz', 'anghami.com': 'Anghami', 'play.anghami.com': 'Anghami', 'audiomack.com': 'Audiomack', 'bandcamp.com': 'Bandcamp', 'spotify.link': 'Spotify', 'on.soundcloud.com': 'SoundCloud', 'pandora.com': 'Pandora' };
function parseLink(link) {
  let u; try { u = new URL(String(link || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const raw = u.hostname.toLowerCase(), plain = raw.replace(/^www\./, '');
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(plain)) {
    let id = null;
    if (plain === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else id = u.searchParams.get('v') || (/^\/(shorts|embed|live)\/([\w-]{11})/.exec(u.pathname) || [])[2];
    return /^[\w-]{11}$/.test(id || '') ? { provider: 'youtube', ref: id, link: 'https://www.youtube.com/watch?v=' + id } : null;
  }
  if (plain === 'open.spotify.com') {
    const m = /^\/(?:intl-[a-z]{2}\/)?(track|episode|album|playlist|show)\/([A-Za-z0-9]{22})/.exec(u.pathname);
    return m ? { provider: 'spotify', ref: `spotify:${m[1]}:${m[2]}`, link: `https://open.spotify.com/${m[1]}/${m[2]}` } : null;
  }
  if (['soundcloud.com', 'm.soundcloud.com'].includes(plain)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || ['discover', 'search', 'you', 'stream', 'charts'].includes(parts[0])) return null;
    const ref = 'https://soundcloud.com/' + parts.slice(0, 3).join('/');
    return { provider: 'soundcloud', ref, link: ref };
  }
  if (u.protocol === 'https:' && /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(u.pathname)) return { provider: 'audio', ref: u.href, link: u.href };
  const app = Object.entries(OTHER_APPS).find(([h]) => raw === h || raw.endsWith('.' + h));
  if (app) return { provider: 'other', ref: u.href, link: u.href, app: app[1] };
  return null;
}
const linkId = pl => 'ln:' + pl.provider + ':' + crypto.createHash('sha1').update(pl.ref).digest('hex').slice(0, 12);
const LINK_TITLES = { youtube: 'YouTube video', spotify: 'Spotify track', soundcloud: 'SoundCloud track', audio: 'Audio link', other: 'Shared song' };
// Whitelisted copy of a client-supplied track (never relay arbitrary objects). Link tracks are rebuilt from the link alone.
function safeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = { title: String(raw.title || 'Untitled').slice(0, 150), artist: String(raw.artist || '').slice(0, 100), durationMs: Math.max(0, Number(raw.durationMs) || 0) };
  const pl = raw.link ? parseLink(raw.link) : null;
  if (pl) return { id: linkId(pl), ...base, provider: pl.provider, ref: pl.ref, link: pl.link, app: pl.app || '', url: pl.provider === 'audio' ? pl.ref : '' };
  const id = String(raw.id || '').slice(0, 80);
  return id ? { id, ...base, url: '' } : null;
}
const pairKey = (a, b) => [a, b].sort().join(':');
function pairOf(uid) {
  const partner = partnerOf(uid); if (!partner) return null;
  const key = pairKey(uid, partner.id);
  if (!pairs.has(key)) pairs.set(key, { favorites: [], playlists: [] });
  return { key, data: pairs.get(key), partner };
}
// Normalises a song reference: either a library track (trackId) or metadata-only (shared from any player).
function cleanItem(i, uid) {
  if (!i || typeof i !== 'object') return null;
  const t = visibleTrack(uid, i.trackId), trackId = t ? t.id : null;
  let title = String(t?.title || i.title || '').trim().slice(0, 150);
  const artist = String(t?.artist || i.artist || '').trim().slice(0, 100);
  const rawLink = /^https?:\/\//i.test(String(i.link || '')) ? String(i.link).slice(0, 500) : '';
  const pl = trackId ? null : parseLink(rawLink);
  const link = pl ? pl.link : rawLink;
  if (!title && pl) title = LINK_TITLES[pl.provider] || 'Shared song';
  if (!title) return null;
  const key = trackId || (pl ? 'lk:' + linkId(pl) : 'ext:' + (title + '|' + artist).toLowerCase());
  return { key, trackId, provider: pl?.provider || null, ref: pl?.ref || null, linkId: pl ? linkId(pl) : null, app: pl?.app || '', title, artist, link, addedBy: uid };
}
function activeSessionOf(uid) { return [...sessions.values()].find(s => s.active && (s.a === uid || s.b === uid)) || null; }

app.post('/api/users', rateLimit(10, 60 * 60 * 1000), (req, res) => {
  const name = String(req.body?.name || 'Listener').trim().slice(0, 30) || 'Listener';
  const token = crypto.randomBytes(32).toString('hex');
  const user = { id: 'u_' + crypto.randomUUID(), name, tokenHash: tokenHash(token), code: rand(), partnerId: null, online: false };
  users.set(user.id, user); saveData();
  res.status(201).json({ userId: user.id, token, code: user.code, name: user.name });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const u = userForToken(token);
  if (!u) return next(new Error('Authentication failed. Please create an account again.'));
  socket.userId = u.id; next();
});
io.on('connection', socket => {
  const me = users.get(socket.userId);
  const eventHits = new Map();
  function limited(event, max, windowMs, handler) { socket.on(event, (...args) => { const now = Date.now(), times = (eventHits.get(event) || []).filter(t => now - t < windowMs); if (times.length >= max) { const ack = args.find(a => typeof a === 'function'); if (ack) ack({ ok: false, error: 'Too many requests. Please wait a moment.' }); return; } times.push(now); eventHits.set(event, times); handler(...args); }); }

  me.online = true;
  socket.join('user:' + me.id);
  socket.emit('clock:sync', { serverTime: Date.now() });
  socket.on('clock:sync', () => socket.emit('clock:sync', { serverTime: Date.now() }));
  const p = partnerOf(me.id);
  if (p) {
    socket.emit('partner:info', publicUser(p));
    socket.to('user:' + p.id).emit('partner:presence', { online: true });
    if (states.has(p.id)) socket.emit('partner:state', states.get(p.id));
  }
  const existing = activeSessionOf(me.id);
  if (existing) {
    socket.join('session:' + existing.id);
    socket.emit('session:resume', { session: existing });
    socket.to('session:' + existing.id).emit('session:peer-joined', { user: publicUser(me) });
  }


  function openSession() {
    const partner = partnerOf(me.id);
    const sess = { id: rand(12), a: me.id, b: partner.id, active: true, startedAt: Date.now() };
    sessions.set(sess.id, sess);
    socket.join('session:' + sess.id);
    io.to('user:' + partner.id).emit('session:invite', { session: sess, from: publicUser(me), item: openSession.item || null });
    socket.emit('session:started', { session: sess });
    return sess;
  }
  const sharedPayload = pr => ({ favorites: pr.data.favorites, playlists: pr.data.playlists });
  const pushShared = pr => { saveData(); io.to('user:' + me.id).to('user:' + pr.partner.id).emit('shared:update', sharedPayload(pr)); };
  const NEED_PAIR = { ok: false, error: 'Pair with someone first.' };
  // Recently played: per account (not shared), newest first, stored in data.json with the user.
  const RECENT_MAX = 30;
  socket.on('recent:get', (_p, ack = () => {}) => ack({ ok: true, recent: me.recent || [] }));
  limited('recent:add', 30, 60_000, (p = {}, ack = () => {}) => {
    const item = cleanItem(p.item, me.id); if (!item) return ack({ ok: false, error: 'Invalid song.' });
    me.recent = [{ ...item, playedAt: Date.now() }, ...(me.recent || []).filter(x => x.key !== item.key)].slice(0, RECENT_MAX);
    saveData(); io.to('user:' + me.id).emit('recent:update', { recent: me.recent }); ack({ ok: true });
  });
  limited('recent:clear', 5, 60_000, (_p, ack = () => {}) => { me.recent = []; saveData(); io.to('user:' + me.id).emit('recent:update', { recent: [] }); ack({ ok: true }); });
  socket.on('shared:get', (_p, ack = () => {}) => { const pr = pairOf(me.id); ack(pr ? { ok: true, ...sharedPayload(pr) } : NEED_PAIR); });
  limited('fav:toggle', 30, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const item = cleanItem(p.item, me.id); if (!item) return ack({ ok: false, error: 'Invalid song.' });
    const f = pr.data.favorites, i = f.findIndex(x => x.key === item.key);
    if (i >= 0) f.splice(i, 1); else if (f.length < 500) f.push(item); else return ack({ ok: false, error: 'Favorites list is full.' });
    pushShared(pr); ack({ ok: true, favorite: i < 0 });
  });
  limited('playlist:create', 10, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const name = String(p.name || '').trim().slice(0, 40); if (!name) return ack({ ok: false, error: 'Name your playlist.' });
    if (pr.data.playlists.length >= 50) return ack({ ok: false, error: 'Too many playlists.' });
    const pl = { id: rand(10), name, items: [], createdBy: me.id };
    pr.data.playlists.push(pl); pushShared(pr); ack({ ok: true, playlist: pl });
  });
  limited('playlist:add', 30, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const pl = pr.data.playlists.find(x => x.id === p.id); const item = cleanItem(p.item, me.id);
    if (!pl || !item) return ack({ ok: false, error: 'Playlist or song not found.' });
    if (pl.items.some(x => x.key === item.key)) return ack({ ok: false, error: 'Already in this playlist.' });
    if (pl.items.length >= 500) return ack({ ok: false, error: 'Playlist is full.' });
    pl.items.push(item); pushShared(pr); ack({ ok: true });
  });
  limited('playlist:remove', 30, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const pl = pr.data.playlists.find(x => x.id === p.id); if (!pl) return ack({ ok: false, error: 'Playlist not found.' });
    pl.items = pl.items.filter(x => x.key !== p.key); pushShared(pr); ack({ ok: true });
  });
  limited('playlist:delete', 10, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    pr.data.playlists = pr.data.playlists.filter(x => x.id !== p.id); pushShared(pr); ack({ ok: true });
  });
  // Invite the partner to listen to a song. Library tracks open a synced session; songs shared from any
  // other player (metadata only) arrive as a suggestion the partner can favorite or look up.
  limited('track:invite', 15, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const item = cleanItem(p.item, me.id); if (!item) return ack({ ok: false, error: 'Invalid song.' });
    if (item.trackId || item.provider) {
      if (!activeSessionOf(me.id)) { openSession.item = item; openSession(); openSession.item = null; }
      return ack({ ok: true, session: true, item });
    }
    io.to('user:' + pr.partner.id).emit('track:suggest', { from: me.name, item });
    ack({ ok: true, session: false, item });
  });

  limited('pair:accept', 10, 10 * 60_000, (payload = {}, ack = () => {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const now = Date.now();
    me._pairFails = (me._pairFails || []).filter(t => now - t < 10 * 60 * 1000);
    if (me._pairFails.length >= 5) return ack({ ok: false, error: 'Too many attempts. Wait a few minutes.' });
    const target = [...users.values()].find(u => u.code === code);
    if (!target) { me._pairFails.push(now); return ack({ ok: false, error: 'Pair code not found.' }); }
    if (target.id === me.id) return ack({ ok: false, error: 'You cannot pair with yourself.' });
    if (me.partnerId || target.partnerId) return ack({ ok: false, error: 'One of these accounts is already paired.' });
    me.partnerId = target.id; target.partnerId = me.id; me.code = rand(); target.code = rand(); saveData();
    socket.emit('partner:info', publicUser(target));
    io.to('user:' + target.id).emit('partner:info', publicUser(me));
    ack({ ok: true, partner: publicUser(target) });
  });

  limited('state:update', 20, 60_000, s => {
    if (!s || typeof s !== 'object') return;
    const track = pubTrack(visibleTrack(me.id, s.trackId));
    const stamped = { trackId: (track || safeTrack(s.track))?.id || String(s.trackId || 'external'), track: track || safeTrack(s.track), source: s.source || 'syncpair', fingerprint: String(s.fingerprint || ''), positionMs: Math.max(0, Number(s.positionMs) || 0), isPlaying: !!s.isPlaying, userId: me.id, serverTime: Date.now() };
    states.set(me.id, stamped);
    const partner = partnerOf(me.id);
    if (partner) socket.to('user:' + partner.id).emit('partner:state', stamped);
  });

  limited('session:start', 10, 60_000, (_payload, ack = () => {}) => {
    const partner = partnerOf(me.id);
    if (!partner) return ack({ ok: false, error: 'Pair with someone first.' });
    const current = activeSessionOf(me.id);
    if (current) { socket.join('session:' + current.id); return ack({ ok: true, session: current }); }
    const sess = openSession();
    ack({ ok: true, session: sess });
  });
  limited('session:join', 10, 60_000, ({ id } = {}, ack = () => {}) => {
    const sess = sessions.get(id);
    if (!sess || !sess.active || (sess.a !== me.id && sess.b !== me.id)) return ack({ ok: false, error: 'This invitation is no longer available.' });
    socket.join('session:' + id);
    socket.to('session:' + id).emit('session:peer-joined', { user: publicUser(me) });
    socket.emit('session:started', { session: sess });
    ack({ ok: true });
  });
  socket.on('session:leave', () => {
    const sess = activeSessionOf(me.id); if (!sess) return;
    sess.active = false;
    io.to('session:' + sess.id).emit('session:ended', { id: sess.id });
    sessions.delete(sess.id);
  });
  limited('session:control', 60, 60_000, c => {
    const sess = activeSessionOf(me.id); if (!sess || !c || typeof c !== 'object') return;
    const track = pubTrack(visibleTrack(me.id, c.trackId)) || safeTrack(c.track);
    const evt = { type: ['play', 'pause', 'seek', 'skip', 'previous', 'next', 'select', 'sync'].includes(c.type) ? c.type : 'play', trackId: track?.id || String(c.trackId || 'external'), track, source: c.source || 'syncpair', fingerprint: String(c.fingerprint || ''), positionMs: Math.max(0, Number(c.positionMs) || 0), isPlaying: !!c.isPlaying, from: me.id, fromName: me.name, serverTime: Date.now() };
    socket.to('session:' + sess.id).emit('session:control', evt);
  });
  limited('react', 30, 60_000, payload => {
    const partner = partnerOf(me.id); if (!partner) return;
    const emoji = String(payload?.emoji || '').slice(0, 8); if (!emoji) return;
    io.to('user:' + partner.id).emit('react', { emoji, positionMs: Math.max(0, Number(payload.positionMs) || 0), from: me.name, serverTime: Date.now() });
  });
  limited('chat', 20, 60_000, payload => {
    const partner = partnerOf(me.id); const message = String(payload?.text || '').trim().slice(0, 500);
    if (partner && message) io.to('user:' + partner.id).emit('chat', { text: message, from: me.name, serverTime: Date.now() });
  });
  socket.on('disconnect', () => {
    const anotherConnection = [...io.sockets.sockets.values()].some(s => s.userId === me.id);
    me.online = anotherConnection;
    const partner = partnerOf(me.id); if (partner) io.to('user:' + partner.id).emit('partner:presence', { online: anotherConnection });
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SyncPair listening on http://localhost:${PORT}`));
