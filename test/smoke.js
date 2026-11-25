/* End-to-end smoke test: node test/smoke.js  (starts the server on a temp data dir, drives it with two clients) */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { io } = require('socket.io-client');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syncpair-test-'));
const PORT = 3100 + Math.floor(Math.random() * 500), BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startServer = () => new Promise((resolve, reject) => {
  const child = spawn('node', [path.join(__dirname, '..', 'index.js')], { env: { ...process.env, PORT, DATA_DIR }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(child); });
  child.on('error', reject);
});
const api = (token, method, url, body, headers = {}) => fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const connect = token => new Promise((resolve, reject) => { const s = io(BASE, { auth: { token } }); s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
const call = (s, event, payload) => new Promise(r => s.emit(event, payload, r));
const once = (s, event) => new Promise(r => s.once(event, r));
const newUser = async name => (await fetch(BASE + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();

(async () => {
  let server = await startServer();
  try {
    const A = await newUser('alice'), B = await newUser('bob');
    const sa = await connect(A.token), sb = await connect(B.token);
    assert.ok((await call(sb, 'pair:accept', { code: A.code })).ok, 'pairing');

    // static + error handling
    const manifest = await fetch(BASE + '/manifest.webmanifest');
    assert.strictEqual(manifest.status, 200); assert.match(manifest.headers.get('content-type'), /manifest\+json/);
    assert.strictEqual((await fetch(BASE + '/icon-192.png')).status, 200);
    const sw = await fetch(BASE + '/sw.js');
    assert.strictEqual(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/); assert.strictEqual(sw.headers.get('cache-control'), 'no-cache', 'service worker is never cached by the browser');
    assert.strictEqual((await fetch(BASE + '/data.json')).status, 404, 'data file is never served');
    const badJson = await fetch(BASE + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.strictEqual(badJson.status, 400); assert.ok((await badJson.json()).error, 'errors are JSON, not HTML');
    assert.strictEqual((await fetch(BASE + '/music/whatever.mp3')).status, 404, 'audio needs a token');

    // upload -> partner is notified and sees the song (no reload needed)
    const changed = once(sb, 'library:changed');
    const up = await api(A.token, 'POST', '/api/library', Buffer.from('ID3-fake-audio-bytes'), { 'Content-Type': 'audio/mpeg', 'X-File-Name': 'song.mp3', 'X-Track-Title': 'First', 'X-Track-Duration-Ms': '1000' });
    assert.strictEqual(up.status, 201); assert.strictEqual(up.body.mine, true);
    await changed;
    const listB = await api(B.token, 'GET', '/api/library');
    assert.strictEqual(listB.body.length, 1); assert.strictEqual(listB.body[0].mine, false);
    const id = up.body.id;

    // shared lists reference the song
    assert.ok((await call(sa, 'fav:toggle', { item: { trackId: id } })).ok);
    const pl = await call(sa, 'playlist:create', { name: 'Road trip' });
    assert.ok((await call(sa, 'playlist:add', { id: pl.playlist.id, item: { trackId: id } })).ok);
    assert.ok((await call(sa, 'playlist:add', { id: pl.playlist.id, item: { title: 'Ext song', artist: 'X' } })).ok);

    // playlist rename + reorder
    assert.ok((await call(sb, 'playlist:rename', { id: pl.playlist.id, name: 'Night drive' })).ok);
    assert.ok((await call(sa, 'playlist:move', { id: pl.playlist.id, key: id, direction: 1 })).ok);
    let shared = await call(sa, 'shared:get', {});
    assert.strictEqual(shared.playlists[0].name, 'Night drive');
    assert.strictEqual(shared.playlists[0].items[1].key, id, 'song moved down');
    assert.strictEqual((await call(sa, 'playlist:move', { id: pl.playlist.id, key: id, direction: 1 })).ok, false, 'cannot move past the end');

    // rename propagates to favorites + playlists, either partner may edit
    const upd = once(sa, 'shared:update');
    assert.strictEqual((await api(B.token, 'PATCH', '/api/library/' + id, { title: 'Renamed', artist: 'Band' })).status, 200);
    await upd;
    shared = await call(sa, 'shared:get', {});
    assert.strictEqual(shared.favorites[0].title, 'Renamed');
    assert.strictEqual(shared.playlists[0].items.find(i => i.trackId === id).artist, 'Band');

    // shared Up next queue: both partners edit it, entries are consumed once, deleted songs leave it
    assert.ok((await call(sa, 'queue:add', { item: { trackId: id } })).ok);
    assert.ok((await call(sb, 'queue:add', { item: { title: 'Yt', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })).ok, 'partner can queue a link');
    assert.strictEqual((await call(sa, 'queue:add', { item: { trackId: id } })).ok, false, 'no duplicates in Up next');
    assert.strictEqual((await call(sa, 'queue:add', { item: { title: 'No link', artist: 'X' } })).ok, false, 'title-only songs cannot be queued');
    assert.ok((await call(sb, 'queue:move', { key: id, direction: 1 })).ok, 'move the first entry down');
    assert.strictEqual((await call(sb, 'queue:move', { key: id, direction: 1 })).ok, false, 'last entry cannot move down');
    shared = await call(sa, 'shared:get', {});
    assert.strictEqual(shared.queue.length, 2); assert.strictEqual(shared.queue[1].key, id, 'queue reordered');
    const head = await call(sb, 'queue:shift', {});
    assert.ok(head.ok && head.item.provider === 'youtube', 'shift returns the head link');
    assert.strictEqual((await call(sa, 'shared:get', {})).queue.length, 1, 'shifted entry is gone for both');

    // long-distance extras: time zone + status, shared countdown, pings
    const gotProfile = once(sb, 'partner:profile');
    assert.ok((await call(sa, 'profile:set', { tz: 'Africa/Tunis', status: { emoji: '😴', text: 'heading to bed' } })).ok);
    const prof = await gotProfile; assert.strictEqual(prof.tz, 'Africa/Tunis'); assert.strictEqual(prof.status.text, 'heading to bed');
    assert.strictEqual((await call(sa, 'profile:set', { tz: 'Mars/Olympus' })).tz, 'Africa/Tunis', 'invalid time zones are ignored');
    assert.ok((await call(sb, 'us:set', { countdown: { date: '2027-01-15', label: 'Airport' }, since: '2024-05-01' })).ok);
    assert.strictEqual((await call(sb, 'us:set', { countdown: { date: '2027-02-31', label: 'x' } })).ok, false, 'impossible dates are rejected');
    shared = await call(sa, 'shared:get', {});
    assert.strictEqual(shared.countdown.label, 'Airport'); assert.strictEqual(shared.since, '2024-05-01');
    const gotPing = once(sb, 'ping:received');
    assert.ok((await call(sa, 'ping:send', { kind: 'night' })).ok);
    assert.strictEqual((await gotPing).kind, 'night', 'partner receives the ping live');
    assert.strictEqual((await call(sa, 'ping:send', { kind: 'bomb' })).ok, false, 'unknown ping kinds are rejected');
    assert.strictEqual((await call(sb, 'shared:get', {})).pings.length, 1, 'pings are kept as moments');

    // staying signed in: cookie backup, and automatic restore after the server forgot the accounts
    const crypto = require('crypto');
    const reg = await fetch(BASE + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'cookie' }) });
    const setCookie = reg.headers.get('set-cookie'), regBody = await reg.json();
    assert.match(setCookie, /sp_session=[0-9a-f]{64}/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Max-Age=31536000/);
    const sess = await fetch(BASE + '/api/session', { headers: { Cookie: setCookie.split(';')[0] } });
    assert.strictEqual(sess.status, 200); const sessBody = await sess.json();
    assert.strictEqual(sessBody.userId, regBody.userId); assert.strictEqual(sessBody.token, regBody.token);
    assert.strictEqual((await fetch(BASE + '/api/session')).status, 401, 'no cookie, no session');
    const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const mk = () => ({ userId: 'u_' + crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex') });
    const rA = mk(), rB = mk(), rC = mk();
    const ra = await post('/api/restore', { ...rA, name: 'Ra', code: 'ABC123', partnerId: rB.userId });
    assert.strictEqual(ra.status, 200); assert.strictEqual(ra.body.restored, true); assert.strictEqual(ra.body.partnerId, null, 'partner has not come back yet');
    const sRa = await connect(rA.token); // the restored token works for sockets
    assert.strictEqual((await post('/api/restore', { ...rA, name: 'Ra' })).body.restored, false, 'restoring twice is harmless');
    assert.strictEqual((await post('/api/restore', { userId: rA.userId, token: mk().token })).status, 409, 'cannot take over an existing account id');
    assert.strictEqual((await post('/api/restore', { userId: 'nope', token: rA.token })).status, 400, 'invalid ids are rejected');
    const rb = await post('/api/restore', { ...rB, name: 'Rb', code: 'DEF456', partnerId: rA.userId });
    assert.strictEqual(rb.body.partnerId, rA.userId, 'couple is re-linked once both sides claim each other');
    const sRb = await connect(rB.token);
    assert.ok(Array.isArray((await call(sRb, 'shared:get', {})).favorites), 'restored partner can use shared data');
    assert.ok(Array.isArray((await call(sRa, 'shared:get', {})).favorites));
    assert.strictEqual((await post('/api/restore', { ...rC, name: 'Rc', partnerId: rA.userId })).body.partnerId, null, 'a one-sided claim never pairs');
    sRa.close(); sRb.close();

    // only the uploader may delete; delete purges every reference and the file
    assert.strictEqual((await api(B.token, 'DELETE', '/api/library/' + id)).status, 403);
    const file = fs.readdirSync(path.join(DATA_DIR, 'music'))[0]; assert.ok(file);
    assert.strictEqual((await api(A.token, 'DELETE', '/api/library/' + id)).status, 200);
    shared = await call(sa, 'shared:get', {});
    assert.strictEqual(shared.favorites.length, 0); assert.strictEqual(shared.playlists[0].items.length, 1);
    assert.strictEqual(shared.queue.length, 0, 'deleted song leaves Up next');
    assert.ok((await call(sa, 'queue:add', { item: { title: 'Yt2', link: 'https://www.youtube.com/watch?v=abcdefghijk' } })).ok);
    assert.ok((await call(sb, 'queue:clear', {})).ok); assert.strictEqual((await call(sa, 'queue:shift', {})).item, null, 'cleared queue is empty');
    assert.strictEqual(fs.readdirSync(path.join(DATA_DIR, 'music')).length, 0);
    assert.strictEqual((await api(B.token, 'GET', '/api/library')).body.length, 0);

    // sync heartbeat is relayed with isPlaying
    const invite = once(sb, 'session:invite');
    const started = await call(sa, 'session:start', {});
    assert.ok(started.ok); await invite;
    assert.ok((await call(sb, 'session:join', { id: started.session.id })).ok);
    const hb = once(sb, 'session:control');
    sa.emit('session:control', { type: 'sync', trackId: 'ln:x', track: { id: 'ln:x', title: 't', link: 'https://youtu.be/dQw4w9WgXcQ' }, positionMs: 5000, isPlaying: true });
    const evt = await hb; assert.strictEqual(evt.type, 'sync'); assert.strictEqual(evt.isPlaying, true);

    // data survives a restart, and a corrupted data.json falls back to the backup instead of wiping everyone
    sa.close(); sb.close(); await sleep(400);
    server.kill('SIGTERM'); await sleep(300);
    const dataFile = path.join(DATA_DIR, 'data.json');
    assert.ok(fs.existsSync(dataFile + '.bak'), 'backup written');
    fs.writeFileSync(dataFile, '{"users":[{"id":"u_trunc'); // simulate a crash mid-write
    server = await startServer();
    const sa2 = await connect(A.token); // old token still valid => accounts restored from .bak
    assert.ok((await call(sa2, 'shared:get', {})).ok); sa2.close();
    assert.ok(fs.readdirSync(DATA_DIR).some(f => f.startsWith('data.json.corrupt-')), 'corrupt file set aside, not deleted');
    console.log('Server smoke tests passed.');
  } finally {
    await new Promise(r => { server.once('exit', r); server.kill('SIGTERM'); }); // let the shutdown flush finish first
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
