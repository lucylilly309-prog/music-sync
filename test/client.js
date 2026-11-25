/* Client regression tests (jsdom): node test/client.js */
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const root = require('path').join(__dirname, '..') + '/';
const html = fs.readFileSync(root + 'index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:3000/', pretendToBeVisual: true });
const w = dom.window;
// fake socket.io + storage + fetch
const handlers = {}; let emitted = [];
const shiftReplies = [];
w.io = () => ({ on: (e, f) => { handlers[e] = f; }, emit: (e, p, cb) => { emitted.push([e, p]); if (e === 'queue:shift' && cb) cb({ ok: true, item: shiftReplies.shift() || null }); }, connected: true, close() { this.closed = true; } });
w.fetch = async () => ({ ok: true, json: async () => [] });
w.localStorage.setItem('syncpair-account', JSON.stringify({ id: 'u1', name: 'Me', token: 'tok', code: 'ABC123' }));
w.scrollTo = () => {}; w.HTMLMediaElement.prototype.load = () => {}; w.HTMLMediaElement.prototype.pause = () => {};
w.eval(fs.readFileSync(root + 'app.js', 'utf8') + '\n;window.__t = { get noteDraft(){return noteDraft}, get latencyMs(){return latencyMs}, resetAccount };');
(async () => {
  // paired: show partner card
  handlers['partner:info']({ id: 'p', name: 'Sam', online: true });
  const ta = () => w.document.querySelector('.profile-note-composer textarea');
  assert.ok(ta(), 'note box rendered');
  ta().value = 'thinking of you'; ta().dispatchEvent(new w.Event('input'));
  ta().focus();
  // partner playback updates arrive every few seconds; they must not touch the textarea
  const before = ta();
  handlers['partner:state']({ track: { id: 't', title: 'Song', artist: 'Band' }, isPlaying: true, positionMs: 0, serverTime: Date.now() });
  assert.strictEqual(ta(), before, 'same textarea node after partner:state');
  assert.strictEqual(ta().value, 'thinking of you');
  assert.ok(w.document.querySelector('.profile-now-playing b').textContent === 'Song', 'now playing shown');
  // presence / shared updates do rebuild the card, but the draft must survive
  handlers['partner:presence']({ online: false });
  assert.strictEqual(ta().value, 'thinking of you', 'draft kept after rebuild');
  assert.strictEqual(w.document.activeElement, ta(), 'focus kept after rebuild');
  assert.ok(w.document.querySelector('.profile-now-playing'), 'now playing kept after rebuild');
  // Up next: renders from shared:update, its buttons emit queue events, and only a live session consumes it
  const yt = (k, title) => ({ key: k, title, artist: 'X', provider: 'youtube', link: 'https://youtu.be/' + k, linkId: 'yt:' + k, ref: k });
  handlers['shared:update']({ favorites: [], playlists: [], notes: [], roomName: '', queue: [yt('aaaaaaaaaaa', 'First'), yt('bbbbbbbbbbb', 'Second')] });
  const rows = () => [...w.document.querySelectorAll('#queue-list .library-row')];
  assert.strictEqual(rows().length, 2, 'queue rows rendered');
  assert.ok(!w.document.querySelector('#queue-actions').classList.contains('hidden'), 'queue actions shown when something is queued');
  assert.ok(!rows()[0].querySelector('[aria-label="Add to Up next"]'), 'no add button inside the queue itself');
  emitted = [];
  rows()[1].querySelector('[aria-label="Move up"]').click();
  assert.strictEqual(JSON.stringify(emitted[0]), JSON.stringify(['queue:move', { key: 'bbbbbbbbbbb', direction: -1 }]));
  rows()[0].querySelector('[aria-label="Remove from Up next"]').click();
  assert.strictEqual(JSON.stringify(emitted[1]), JSON.stringify(['queue:remove', { key: 'aaaaaaaaaaa' }]));
  w.document.querySelector('#btn-clear-queue').click(); assert.strictEqual(emitted[2][0], 'queue:clear');
  emitted = []; w.eval('skip(1)'); await new Promise(r => setTimeout(r, 20));
  assert.ok(!emitted.some(e => e[0] === 'queue:shift'), 'next outside a session does not consume Up next');
  handlers['session:started']({ session: { id: 's1', a: 'u1', b: 'p' } });
  shiftReplies.push(yt('aaaaaaaaaaa', 'First')); emitted = []; w.eval('skip(1)'); await new Promise(r => setTimeout(r, 20));
  assert.ok(emitted.some(e => e[0] === 'queue:shift'), 'next inside a session takes the head of Up next');
  handlers['shared:update']({ queue: [] });
  assert.ok(w.document.querySelector('#queue-actions').classList.contains('hidden') && /Nothing queued/.test(w.document.querySelector('#queue-list').textContent), 'empty state');
  handlers['session:ended']();
  // one-tap "Listen along": offered only for a song we can play, and starts the invite at the partner's position
  assert.ok(!w.document.querySelector('.listen-along'), 'no listen-along for a song that cannot be played here');
  handlers['partner:state']({ track: { id: 'yt:aaaaaaaaaaa', title: 'Linked', artist: 'Band', link: 'https://youtu.be/aaaaaaaaaaa' }, isPlaying: true, positionMs: 5000, serverTime: Date.now() });
  const along = w.document.querySelector('.listen-along'); assert.ok(along, 'listen-along shown for a playable link');
  emitted = []; along.click();
  assert.strictEqual(emitted[0][0], 'track:invite'); assert.strictEqual(emitted[0][1].item.link, 'https://youtu.be/aaaaaaaaaaa');
  // headphone delay: saved per device and applied
  const lat = w.document.querySelector('#latency-control'); lat.value = '200'; lat.dispatchEvent(new w.Event('input'));
  assert.strictEqual(w.localStorage.getItem('syncpair-latency'), '200'); assert.strictEqual(w.__t.latencyMs, 200);
  assert.strictEqual(w.document.querySelector('#latency-value').textContent, '+200 ms');
  // connection loss is visible, and recovery says so
  handlers['disconnect'](); assert.ok(/Connection lost/.test(w.document.querySelector('#toast').textContent));
  handlers['connect'](); assert.ok(/Back online/.test(w.document.querySelector('#toast').textContent));
  // long distance: partner's local time + status, countdown, pings
  handlers['partner:profile']({ tz: 'Asia/Tokyo', status: { emoji: '😴', text: 'heading to bed' } });
  assert.ok(/Sam: /.test(w.document.querySelector('#us-time').textContent), 'partner local time shown');
  assert.ok(/heading to bed/.test(w.document.querySelector('#us-status-partner').textContent), 'partner status shown');
  const dd = new Date(); dd.setDate(dd.getDate() + 10);
  const iso = [dd.getFullYear(), String(dd.getMonth() + 1).padStart(2, '0'), String(dd.getDate()).padStart(2, '0')].join('-');
  handlers['shared:update']({ countdown: { date: iso, label: 'Airport' }, since: '2024-05-01', pings: [{ from: 'p', fromName: 'Sam', kind: 'miss', at: Date.now() }], queue: [] });
  assert.ok(/10 days until Airport/.test(w.document.querySelector('#us-countdown').textContent), 'countdown shown');
  assert.ok(/days together/.test(w.document.querySelector('#us-countdown').textContent), 'days together shown');
  assert.ok(/Sam .*Miss you/.test(w.document.querySelector('#us-moments').textContent), 'moments list shown');
  emitted = []; w.document.querySelector('.ping-btn[data-kind="think"]').click();
  assert.strictEqual(JSON.stringify(emitted[0]), JSON.stringify(['ping:send', { kind: 'think' }]));
  handlers['ping:received']({ kind: 'night', fromName: 'Sam', at: Date.now() });
  assert.ok(/Sam .*good night/.test(w.document.querySelector('#toast').textContent), 'incoming ping toast');
  w.document.querySelector('#status-text').value = 'on the bus'; emitted = []; w.document.querySelector('#btn-save-status').click();
  assert.strictEqual(emitted[0][0], 'profile:set'); assert.strictEqual(emitted[0][1].status.text, 'on the bus');
  // stale token -> back to sign-up with a message
  assert.strictEqual(JSON.parse(w.localStorage.getItem('syncpair-account')).partnerId, 'p', 'partner id saved for restores');
  // server forgot the account: restore it silently instead of logging out
  const restoreCalls = []; let restoreReply = { ok: true, body: { userId: 'u1', name: 'Me', code: 'ZZZ999', partnerId: 'p', restored: true } };
  w.fetch = async (url, opts) => url === '/api/restore' ? (restoreCalls.push(JSON.parse(opts.body)), { ok: restoreReply.ok, json: async () => restoreReply.body }) : { ok: true, json: async () => [] };
  const tick = () => new Promise(r => setTimeout(r, 30));
  handlers['connect_error'](new Error('Authentication failed. Please create an account again.')); await tick();
  assert.strictEqual(restoreCalls.length, 1); assert.strictEqual(restoreCalls[0].token, 'tok'); assert.strictEqual(restoreCalls[0].partnerId, 'p');
  assert.ok(w.localStorage.getItem('syncpair-account'), 'still signed in after a restore');
  assert.ok(/signed back in/.test(w.document.querySelector('#toast').textContent), 'person is told what happened');
  assert.ok(w.document.querySelector('#create-box').classList.contains('hidden'), 'sign-up not shown');
  // a refused restore (account id taken) is the only way back to sign-up
  restoreReply = { ok: false, body: { error: 'nope' } };
  handlers['connect_error'](new Error('Authentication failed. Please create an account again.')); await tick();
  assert.strictEqual(w.localStorage.getItem('syncpair-account'), null);
  assert.ok(!w.document.querySelector('#screen-pair').classList.contains('hidden'), 'pair screen visible');
  assert.ok(!w.document.querySelector('#create-box').classList.contains('hidden'), 'sign-up shown');
  assert.ok(/not found/i.test(w.document.querySelector('#pair-status').textContent), 'explanation shown');
  // toast
  w.eval("notify('hello')"); assert.strictEqual(w.document.querySelector('#toast').textContent, 'hello');
  assert.ok(!w.document.querySelector('#toast').classList.contains('hidden'));
  console.log('Client tests passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
