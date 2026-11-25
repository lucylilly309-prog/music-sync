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

// ---- Persistence: atomic, debounced writes with a rolling backup ----
// A crash in the middle of a plain writeFileSync could leave a truncated data.json, and the old loader then
// silently started from an empty database (every account gone). Now: write to a temp file, keep the previous
// good copy as data.json.bak, rename into place, and never discard an unreadable file without setting it aside.
const BAK_FILE = DATA_FILE + '.bak';
let saveTimer = null;
function loadData() {
  for (const file of [DATA_FILE, BAK_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (file === BAK_FILE) console.warn('data.json was unreadable: restored from data.json.bak');
      return data;
    } catch (err) {
      console.error(`Could not read ${path.basename(file)}: ${err.message}`);
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    }
  }
  return { users: [], tracks: [] };
}
function writeDataNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const safeUsers = [...users.values()].map(({ online, _pairFails, token, ...u }) => u);
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ users: safeUsers, tracks: [...tracks.values()], pairs: Object.fromEntries(pairs) }, null, 2));
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) { console.error('Could not save data:', err.message); }
}
// Coalesce bursts of changes (a playlist edit, a favorite toggle...) into one write.
function saveData() { if (!saveTimer) saveTimer = setTimeout(writeDataNow, 250); }

const persisted = loadData();
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
// Store only token hashes on disk; migrate legacy plaintext tokens transparently.
const users = new Map((persisted.users || []).map(u => { const migrated = { ...u, tokenHash: u.tokenHash || (u.token ? tokenHash(u.token) : null), online: false }; delete migrated.token; return [u.id, migrated]; }));
// Hash -> user id index, so authenticating a request is O(1) instead of scanning every account.
const tokenIndex = new Map([...users.values()].filter(u => u.tokenHash).map(u => [u.tokenHash, u.id]));
function userForToken(token) { if (!token) return undefined; const id = tokenIndex.get(tokenHash(token)); return id ? users.get(id) : undefined; }
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
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // embed.html is framed by our own page only
  next();
});
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
  // Drop keys whose hits have all expired; otherwise every client IP ever seen stays in memory.
  setInterval(() => { const now = Date.now(); for (const [k, arr] of hits) if (!arr.some(t => now - t < windowMs)) hits.delete(k); }, Math.max(windowMs, 60_000)).unref();
  return (req, res, next) => {
    const key = req.ip, now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    arr.push(now); hits.set(key, arr); next();
  };
}
// Render's filesystem is wiped on every restart, spin-down and deploy unless a disk is mounted and DATA_DIR points at it.
const EPHEMERAL_HOST = !!process.env.RENDER && !process.env.DATA_DIR;
if (EPHEMERAL_HOST) console.warn('WARNING: running on Render without DATA_DIR. Accounts, playlists and music are lost on every restart. Attach a persistent disk and set DATA_DIR (see DEPLOY-RENDER.md).');
app.get('/health', (_req, res) => res.json({ ok: true, time: Date.now(), persistentStorage: !EPHEMERAL_HOST }));
app.get('/api/library', requireAuth, (req, res) => res.json([...tracks.values()].filter(t => canSee(req.user.id, t)).map(t => pubTrack(t, req.user.id))));
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
  if (dup) return res.status(200).json(pubTrack(dup, req.user.id)); // same audio already in the library
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
  notifyPartner(req.user.id, 'library:changed'); // partner's library list updates without a reload
  res.status(201).json(pubTrack(track, req.user.id));
});
// Rename / re-tag a song. Either partner may edit the metadata of a shared-library song.
app.patch('/api/library/:id', requireAuth, (req, res) => {
  const t = visibleTrack(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: 'Song not found.' });
  const title = String(req.body?.title ?? t.title).trim().slice(0, 100);
  const artist = String(req.body?.artist ?? t.artist).trim().slice(0, 100) || 'Unknown artist';
  if (!title) return res.status(400).json({ error: 'A song needs a title.' });
  t.title = title; t.artist = artist;
  // Favorites, playlists and history keep a copy of the title; keep those copies in step.
  const sync = i => { if (i.trackId === t.id) { i.title = title; i.artist = artist; } };
  pairs.forEach(d => { (d.favorites || []).forEach(sync); (d.queue || []).forEach(sync); (d.playlists || []).forEach(pl => (pl.items || []).forEach(sync)); });
  users.forEach(u => (u.recent || []).forEach(sync));
  saveData(); notifyLibrary(req.user.id); pushSharedFor(req.user.id);
  res.json(pubTrack(t, req.user.id));
});
// Delete a song (uploader only): removes the file and every favorite / playlist / history entry pointing at it.
app.delete('/api/library/:id', requireAuth, (req, res) => {
  const t = visibleTrack(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: 'Song not found.' });
  if (t.uploadedBy !== req.user.id) return res.status(403).json({ error: 'Only the person who uploaded this song can delete it.' });
  tracks.delete(t.id);
  try { fs.unlinkSync(path.join(MUSIC_DIR, path.basename(t.url))); } catch {}
  const keep = i => i.trackId !== t.id;
  pairs.forEach(d => { d.favorites = (d.favorites || []).filter(keep); d.queue = (d.queue || []).filter(keep); (d.playlists || []).forEach(pl => { pl.items = (pl.items || []).filter(keep); }); });
  users.forEach(u => { if (u.recent) u.recent = u.recent.filter(keep); });
  saveData(); notifyLibrary(req.user.id); pushSharedFor(req.user.id);
  res.json({ ok: true });
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
// Only these files are public; everything else (data.json, music/, source) is never served statically.
const STATIC_FILES = {
  '/': ['index.html'], '/app.js': ['app.js'], '/embed.html': ['embed.html'], '/style.css': ['style.css'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'application/javascript'],
  '/icon-192.png': ['icon-192.png'], '/icon-512.png': ['icon-512.png'], '/apple-touch-icon.png': ['apple-touch-icon.png'],
};
for (const [route, [file, type]] of Object.entries(STATIC_FILES)) {
  app.get(route, (_req, res) => { if (type) res.type(type); if (route === '/sw.js') res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, file)); });
}
const server = http.createServer(app);
const io = new Server(server);
const rand = (n = 6) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n).toUpperCase();
const publicUser = u => ({ id: u.id, name: u.name, online: !!u.online, tz: u.tz || '', status: u.status || null });
const partnerOf = uid => { const u = users.get(uid); return u?.partnerId ? users.get(u.partnerId) : null; };
// A library track belongs to the account that uploaded it and is shared with that account's partner only.
const canSee = (uid, t) => !!t && !!t.uploadedBy && (t.uploadedBy === uid || partnerOf(uid)?.id === t.uploadedBy);
const visibleTrack = (uid, id) => { const t = id ? tracks.get(String(id)) : null; return canSee(uid, t) ? t : null; };
const pubTrack = (t, uid) => { if (!t) return t; const { hash, uploadedBy, ...pub } = t; if (uid) pub.mine = uploadedBy === uid; return pub; };
const sharedPayload = pr => ({ favorites: pr.data.favorites, playlists: pr.data.playlists, notes: pr.data.notes || [], roomName: pr.data.roomName || '', queue: pr.data.queue || [], countdown: pr.data.countdown || null, since: pr.data.since || '', pings: (pr.data.pings || []).slice(-10) });
const notifyPartner = (uid, event) => { const p = partnerOf(uid); if (p) io.to('user:' + p.id).emit(event); };
const notifyLibrary = uid => { io.to('user:' + uid).emit('library:changed'); notifyPartner(uid, 'library:changed'); };
// Push the couple's shared lists (and each person's history) after a change made outside a socket handler.
function pushSharedFor(uid) {
  const pr = pairOf(uid); if (!pr) return;
  io.to('user:' + uid).to('user:' + pr.partner.id).emit('shared:update', sharedPayload(pr));
  [users.get(uid), pr.partner].forEach(u => u && io.to('user:' + u.id).emit('recent:update', { recent: u.recent || [] }));
}
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
  if (!pairs.has(key)) pairs.set(key, { favorites: [], playlists: [], notes: [], queue: [], countdown: null, since: '', pings: [] });
  const data = pairs.get(key);
  if (!Array.isArray(data.notes)) data.notes = []; // migrate existing pair data
  if (!Array.isArray(data.queue)) data.queue = [];
  if (!Array.isArray(data.pings)) data.pings = [];
  return { key, data, partner };
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

// ---- Staying signed in ----
// The token lives in the browser's localStorage AND in an HttpOnly cookie, so clearing one does not log anyone out.
// If the server itself forgot the account (data reset), /api/restore re-creates it from what the phone still holds.
const cookieToken = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)sp_session=([0-9a-f]{64})/i) || [])[1] || '';
function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', `sp_session=${token}; Max-Age=${365 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
}
app.get('/api/session', rateLimit(60, 60 * 60 * 1000), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = cookieToken(req), u = userForToken(token);
  if (!u) return res.status(401).json({ error: 'No saved session.' });
  setSessionCookie(req, res, token);
  res.json({ userId: u.id, token, code: u.code, name: u.name, partnerId: u.partnerId || null });
});
app.post('/api/restore', rateLimit(30, 60 * 60 * 1000), (req, res) => {
  const b = req.body || {}, id = String(b.userId || ''), token = String(b.token || '');
  if (!/^u_[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(token)) return res.status(400).json({ error: 'Invalid account data.' });
  const hash = tokenHash(token), existing = users.get(id);
  let user = existing;
  if (existing) {
    if (existing.tokenHash !== hash) return res.status(409).json({ error: 'This account id belongs to someone else.' });
  } else {
    if (tokenIndex.has(hash)) return res.status(409).json({ error: 'This sign-in is already in use.' });
    let code = String(b.code || '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(code) || [...users.values()].some(u => u.code === code)) code = rand();
    user = { id, name: String(b.name || 'Listener').trim().slice(0, 30) || 'Listener', tokenHash: hash, code, partnerId: null, online: false };
    users.set(id, user); tokenIndex.set(hash, id);
  }
  // Re-link the couple only when both sides claim each other, each proving itself with its own token.
  const pid = String(b.partnerId || '');
  if (!user.partnerId && pid && pid !== id) {
    const other = users.get(pid);
    if (other && (other.partnerId === id || (!other.partnerId && other.wantsPartner === id))) {
      user.partnerId = pid; other.partnerId = id; delete user.wantsPartner; delete other.wantsPartner;
    } else if (!other) user.wantsPartner = pid;
  }
  saveData(); setSessionCookie(req, res, token);
  res.json({ userId: user.id, token, code: user.code, name: user.name, partnerId: user.partnerId || null, restored: !existing });
});

app.post('/api/users', rateLimit(10, 60 * 60 * 1000), (req, res) => {
  const name = String(req.body?.name || 'Listener').trim().slice(0, 30) || 'Listener';
  const token = crypto.randomBytes(32).toString('hex');
  const user = { id: 'u_' + crypto.randomUUID(), name, tokenHash: tokenHash(token), code: rand(), partnerId: null, online: false };
  users.set(user.id, user); tokenIndex.set(user.tokenHash, user.id); saveData();
  setSessionCookie(req, res, token);
  res.status(201).json({ userId: user.id, token, code: user.code, name: user.name });
});

// Body-parser and other errors used to come back as an HTML stack page; the client expects JSON.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = err.type === 'entity.too.large' ? 'That upload is too large.' : status < 500 ? 'Invalid request.' : 'Something went wrong on the server.';
  res.status(status).json({ error: message });
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
  const pushShared = pr => { saveData(); io.to('user:' + me.id).to('user:' + pr.partner.id).emit('shared:update', sharedPayload(pr)); };
  const NEED_PAIR = { ok: false, error: 'Pair with someone first.' };

  // Little notes live on the couple's partner-profile wall, outside listening sessions.
  socket.on('notes:get', (_payload, ack = () => {}) => {
    const pr = pairOf(me.id);
    ack(pr ? { ok: true, notes: pr.data.notes || [] } : NEED_PAIR);
  });
  limited('note:add', 12, 60_000, (payload = {}, ack = () => {}) => {
    const pr = pairOf(me.id);
    if (!pr) return ack(NEED_PAIR);
    const text = String(payload.text || '').trim().slice(0, 280);
    if (!text) return ack({ ok: false, error: 'Write a little note first.' });
    if (pr.data.notes.length >= 200) return ack({ ok: false, error: 'Your note wall is full.' });
    const note = {
      id: crypto.randomUUID(),
      fromId: me.id,
      fromName: me.name,
      text,
      createdAt: Date.now()
    };
    pr.data.notes.push(note);
    pushShared(pr);
    ack({ ok: true, note });
  });
  limited('note:delete', 20, 60_000, (payload = {}, ack = () => {}) => {
    const pr = pairOf(me.id);
    if (!pr) return ack(NEED_PAIR);
    const index = pr.data.notes.findIndex(n => n.id === payload.id && n.fromId === me.id);
    if (index < 0) return ack({ ok: false, error: 'You can only remove notes you wrote.' });
    pr.data.notes.splice(index, 1);
    pushShared(pr);
    ack({ ok: true });
  });
  // Recently played: per account (not shared), newest first, stored in data.json with the user.
  const RECENT_MAX = 30;
  socket.on('recent:get', (_p, ack = () => {}) => ack({ ok: true, recent: me.recent || [] }));
  limited('recent:add', 30, 60_000, (p = {}, ack = () => {}) => {
    const item = cleanItem(p.item, me.id); if (!item) return ack({ ok: false, error: 'Invalid song.' });
    me.recent = [{ ...item, playedAt: Date.now() }, ...(me.recent || []).filter(x => x.key !== item.key)].slice(0, RECENT_MAX);
    saveData(); io.to('user:' + me.id).emit('recent:update', { recent: me.recent }); ack({ ok: true });
  });
  limited('recent:clear', 5, 60_000, (_p, ack = () => {}) => { me.recent = []; saveData(); io.to('user:' + me.id).emit('recent:update', { recent: [] }); ack({ ok: true }); });
  limited('room:set', 20, 60_000, (payload = {}, ack = () => {}) => {
    const pr = pairOf(me.id);
    if (!pr) return ack(NEED_PAIR);
    pr.data.roomName = String(payload.name || '').trim().slice(0, 40);
    pushShared(pr);
    ack({ ok: true });
  });
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
  limited('playlist:rename', 10, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const pl = pr.data.playlists.find(x => x.id === p.id); if (!pl) return ack({ ok: false, error: 'Playlist not found.' });
    const name = String(p.name || '').trim().slice(0, 40); if (!name) return ack({ ok: false, error: 'Name your playlist.' });
    pl.name = name; pushShared(pr); ack({ ok: true });
  });
  // Move one song up (direction -1) or down (+1) inside a playlist.
  limited('playlist:move', 60, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const pl = pr.data.playlists.find(x => x.id === p.id); if (!pl) return ack({ ok: false, error: 'Playlist not found.' });
    const from = pl.items.findIndex(x => x.key === p.key), to = from + (Number(p.direction) < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= pl.items.length) return ack({ ok: false, error: 'Cannot move it further.' });
    [pl.items[from], pl.items[to]] = [pl.items[to], pl.items[from]];
    pushShared(pr); ack({ ok: true });
  });
  limited('playlist:delete', 10, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    pr.data.playlists = pr.data.playlists.filter(x => x.id !== p.id); pushShared(pr); ack({ ok: true });
  });
  // ---- Long-distance extras: each person's time zone + status, a shared countdown, and one-tap "thinking of you" pings ----
  const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
  const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  limited('profile:set', 20, 60_000, (p = {}, ack = () => {}) => {
    if (typeof p.tz === 'string' && p.tz && p.tz.length <= 64 && validTz(p.tz)) me.tz = p.tz;
    if (p.status && typeof p.status === 'object') {
      const text = String(p.status.text || '').trim().slice(0, 60), emoji = String(p.status.emoji || '').slice(0, 8);
      me.status = text || emoji ? { emoji, text, at: Date.now() } : null;
    }
    saveData();
    const partner = partnerOf(me.id);
    if (partner) io.to('user:' + partner.id).emit('partner:profile', { tz: me.tz || '', status: me.status || null });
    ack({ ok: true, tz: me.tz || '', status: me.status || null });
  });
  limited('us:set', 20, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    if ('countdown' in p) {
      if (!p.countdown) pr.data.countdown = null;
      else {
        const date = String(p.countdown.date || ''), label = String(p.countdown.label || '').trim().slice(0, 50);
        if (!validDay(date)) return ack({ ok: false, error: 'Pick a valid date.' });
        pr.data.countdown = { date, label: label || 'Seeing each other', by: me.id };
      }
    }
    if ('since' in p) {
      const since = String(p.since || '');
      if (since && !validDay(since)) return ack({ ok: false, error: 'Pick a valid start date.' });
      pr.data.since = since;
    }
    pushShared(pr); ack({ ok: true });
  });
  const PING_KINDS = ['think', 'miss', 'morning', 'night'];
  limited('ping:send', 20, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const kind = String(p.kind || ''); if (!PING_KINDS.includes(kind)) return ack({ ok: false, error: 'Unknown message.' });
    const ping = { from: me.id, fromName: me.name, kind, at: Date.now() };
    pr.data.pings = [...(pr.data.pings || []), ping].slice(-30);
    pushShared(pr);
    io.to('user:' + pr.partner.id).emit('ping:received', ping);
    ack({ ok: true, delivered: !!pr.partner.online });
  });
  // Shared "Up next" queue. Either partner can add, reorder or remove; during a session the leader takes the head
  // when a song ends (queue:shift removes it atomically, so both phones never consume the same entry twice).
  limited('queue:add', 30, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const item = cleanItem(p.item, me.id); if (!item) return ack({ ok: false, error: 'Invalid song.' });
    if (!item.trackId && !item.provider) return ack({ ok: false, error: 'Queue an uploaded song or a link (title-only songs cannot be played together).' });
    const q = pr.data.queue;
    if (q.some(x => x.key === item.key)) return ack({ ok: false, error: 'Already in Up next.' });
    if (q.length >= 100) return ack({ ok: false, error: 'Up next is full.' });
    q.push(item); pushShared(pr); ack({ ok: true });
  });
  limited('queue:remove', 30, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    pr.data.queue = pr.data.queue.filter(x => x.key !== p.key); pushShared(pr); ack({ ok: true });
  });
  limited('queue:move', 60, 60_000, (p = {}, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const q = pr.data.queue, from = q.findIndex(x => x.key === p.key), to = from + (Number(p.direction) < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= q.length) return ack({ ok: false, error: 'Cannot move it further.' });
    [q[from], q[to]] = [q[to], q[from]]; pushShared(pr); ack({ ok: true });
  });
  limited('queue:clear', 10, 60_000, (_p, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    pr.data.queue = []; pushShared(pr); ack({ ok: true });
  });
  limited('queue:shift', 30, 60_000, (_p, ack = () => {}) => {
    const pr = pairOf(me.id); if (!pr) return ack(NEED_PAIR);
    const item = pr.data.queue.shift() || null;
    if (item) pushShared(pr);
    ack({ ok: true, item });
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

  limited('state:update', 60, 60_000, s => {
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
// Sessions live in memory; drop ones that nobody has been connected to for 15 minutes so they cannot pile up
// (and so a stale session is not resumed days later).
const sessionIdle = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (users.get(s.a)?.online || users.get(s.b)?.online) { sessionIdle.delete(id); continue; }
    const since = sessionIdle.get(id) || now; sessionIdle.set(id, since);
    if (now - since > 15 * 60_000) { sessions.delete(id); sessionIdle.delete(id); }
  }
}, 60_000).unref();
// Flush pending writes when the host stops the service (Render sends SIGTERM on every deploy).
function shutdown() { writeDataNow(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SyncPair listening on http://localhost:${PORT}`));
