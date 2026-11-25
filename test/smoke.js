/* End-to-end smoke test: node test/smoke.js  (starts the server on a temp data dir, drives it with two clients) */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { io } = require('socket.io-client');
const crypto = require('crypto');
let SERVER_ENV = {}; // extra env for the server under test (mock push services), set before it starts

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syncpair-test-'));
const PORT = 3100 + Math.floor(Math.random() * 500), BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startServer = () => new Promise((resolve, reject) => {
  const child = spawn('node', [path.join(__dirname, '..', 'index.js')], { env: { ...process.env, PORT, DATA_DIR, ...SERVER_ENV }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(child); });
  child.on('error', reject);
});
const api = (token, method, url, body, headers = {}) => fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const connect = token => new Promise((resolve, reject) => { const s = io(BASE, { auth: { token } }); s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
const call = (s, event, payload) => new Promise(r => s.emit(event, payload, r));
const once = (s, event) => new Promise(r => s.once(event, r));
const newUser = async name => (await fetch(BASE + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();

(async () => {
  // Mock push services: an HTTPS "browser push service" and an FCM + OAuth endpoint (plain HTTP via FCM_SEND_BASE).
  const hits = { web: [], fcm: [], fcmAuth: [] };
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cert-'));
  require('child_process').execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${certDir}/k.pem -out ${certDir}/c.pem -days 1 -subj /CN=localhost`, { stdio: 'ignore' });
  const webMock = require('https').createServer({ key: fs.readFileSync(certDir + '/k.pem'), cert: fs.readFileSync(certDir + '/c.pem') }, (req, res) => {
    hits.web.push({ url: req.url, auth: req.headers.authorization, enc: req.headers['content-encoding'] }); req.resume(); res.statusCode = 201; res.end();
  });
  const fcmMock = require('http').createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/token') { hits.fcmAuth.push(body); return res.end(JSON.stringify({ access_token: 'at', expires_in: 3600 })); }
      const msg = JSON.parse(body).message; hits.fcm.push({ url: req.url, auth: req.headers.authorization, msg });
      if (msg.token === 'dead-token') { res.statusCode = 404; return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } })); }
      res.end('{"name":"m"}');
    });
  });
  await Promise.all([new Promise(r => webMock.listen(0, '127.0.0.1', r)), new Promise(r => fcmMock.listen(0, '127.0.0.1', r))]);
  const webPort = webMock.address().port, fcmPort = fcmMock.address().port;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  SERVER_ENV = {
    NODE_TLS_REJECT_UNAUTHORIZED: '0', PUSH_ALLOWED_HOSTS: '127.0.0.1', FCM_SEND_BASE: `http://127.0.0.1:${fcmPort}`, REMINDER_INTERVAL_MS: '300', REMINDER_HOUR: '0',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sp@test-proj.iam.gserviceaccount.com', private_key: privateKey, project_id: 'test-proj', token_uri: `http://127.0.0.1:${fcmPort}/token` })
  };
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

    // notifications: Web Push + FCM go only to people who do not have the app open
    const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; };
    const P = await newUser('pat'), Q = await newUser('quinn');
    const sp = await connect(P.token); let sq = await connect(Q.token);
    assert.ok((await call(sq, 'pair:accept', { code: P.code })).ok);
    const pushKey = await (await fetch(BASE + '/api/push/key')).json();
    assert.ok(pushKey.publicKey.length > 40 && pushKey.fcm === true, 'server exposes its VAPID key and FCM status');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const sub = { endpoint: `https://127.0.0.1:${webPort}/push/q1`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    assert.strictEqual((await api(Q.token, 'POST', '/api/push/subscribe', { subscription: sub })).status, 200);
    assert.strictEqual((await api(Q.token, 'POST', '/api/push/subscribe', { subscription: { ...sub, endpoint: 'https://evil.example.com/x' } })).status, 400, 'only real push services are accepted');
    assert.strictEqual((await api('nope', 'POST', '/api/push/subscribe', { subscription: sub })).status, 401, 'subscribing needs an account');
    assert.strictEqual((await api(Q.token, 'POST', '/api/push/fcm', { token: 'good-token' })).status, 200);
    assert.strictEqual((await api(Q.token, 'POST', '/api/push/fcm', { token: 'dead-token' })).status, 200);
    assert.ok((await call(sp, 'ping:send', { kind: 'think' })).ok); await sleep(400);
    assert.strictEqual(hits.web.length + hits.fcm.length, 0, 'no push while the app is open');
    sq.close(); await sleep(200);
    assert.ok((await call(sp, 'ping:send', { kind: 'miss' })).ok);
    assert.ok(await waitFor(() => hits.web.length >= 1 && hits.fcm.length >= 2), 'a ping reaches both Web Push and FCM');
    assert.match(hits.web[0].auth, /^vapid /i); assert.strictEqual(hits.web[0].enc, 'aes128gcm');
    const good = hits.fcm.find(h => h.msg.token === 'good-token');
    assert.strictEqual(good.url, '/v1/projects/test-proj/messages:send'); assert.strictEqual(good.auth, 'Bearer at');
    assert.match(good.msg.notification.title, /pat/); assert.match(good.msg.notification.body, /misses you/i);
    assert.strictEqual(hits.fcmAuth.length, 1); assert.strictEqual(hits.fcmAuth[0].split('assertion=')[1].split('.').length, 3, 'a signed service-account JWT was exchanged');
    hits.fcm.length = 0;
    assert.strictEqual((await api(P.token, 'POST', '/api/ping', { kind: 'night' })).status, 200, 'the widget button pings over REST');
    assert.ok(await waitFor(() => hits.fcm.length >= 1)); await sleep(300);
    assert.strictEqual(JSON.stringify(hits.fcm.map(h => h.msg.token)), JSON.stringify(['good-token']), 'dead tokens are dropped once FCM says they are gone');
    hits.fcm.length = 0;
    assert.ok((await call(sp, 'note:add', { text: 'secret words' })).ok);
    assert.ok(await waitFor(() => hits.fcm.length >= 1));
    assert.match(hits.fcm[0].msg.notification.title, /note/); assert.ok(!JSON.stringify(hits.fcm[0].msg).includes('secret words'), 'note text never goes through push services');
    hits.fcm.length = 0;
    assert.ok((await call(sp, 'track:invite', { item: { title: 'Yt', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })).ok);
    assert.ok(await waitFor(() => hits.fcm.some(h => /listen/.test(h.msg.notification.title))), 'a listening invite is pushed');
    const wid = await api(Q.token, 'GET', '/api/widget');
    assert.strictEqual(wid.body.paired, true); assert.strictEqual(wid.body.name, 'pat'); assert.strictEqual(wid.body.lastPing.kind, 'night');
    const solo = await newUser('solo'); assert.strictEqual((await api(solo.token, 'GET', '/api/widget')).body.paired, false);
    hits.fcm.length = 0;
    assert.ok((await call(sp, 'us:set', { countdown: { date: new Date().toISOString().slice(0, 10), label: 'Airport' } })).ok);
    assert.ok(await waitFor(() => hits.fcm.some(h => /Airport/.test(h.msg.notification.title))), 'the countdown reminder is pushed');
    const reminders = () => hits.fcm.filter(h => /Airport/.test(h.msg.notification.title)).length, sent = reminders(); await sleep(800);
    assert.strictEqual(reminders(), sent, 'the reminder is sent only once');
    sq = await connect(Q.token); hits.fcm.length = 0; hits.web.length = 0;
    assert.ok((await call(sp, 'ping:send', { kind: 'morning' })).ok); await sleep(400);
    assert.strictEqual(hits.fcm.length + hits.web.length, 0, 'back online: no push again');
    assert.strictEqual((await api(Q.token, 'POST', '/api/push/unsubscribe', { all: true })).status, 200);
    sq.close(); sp.close();

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
    fs.rmSync(certDir, { recursive: true, force: true });
    webMock.close(); fcmMock.close(); webMock.closeAllConnections?.(); fcmMock.closeAllConnections?.();
  }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
