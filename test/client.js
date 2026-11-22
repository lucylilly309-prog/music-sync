/* Client regression tests (jsdom): node test/client.js */
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const root = require('path').join(__dirname, '..') + '/';
const html = fs.readFileSync(root + 'index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:3000/', pretendToBeVisual: true });
const w = dom.window;
// fake socket.io + storage + fetch
const handlers = {}; let emitted = [];
w.io = () => ({ on: (e, f) => { handlers[e] = f; }, emit: (e, p, cb) => { emitted.push([e, p]); }, connected: true, close() { this.closed = true; } });
w.fetch = async () => ({ ok: true, json: async () => [] });
w.localStorage.setItem('syncpair-account', JSON.stringify({ id: 'u1', name: 'Me', token: 'tok', code: 'ABC123' }));
w.scrollTo = () => {}; w.HTMLMediaElement.prototype.load = () => {}; w.HTMLMediaElement.prototype.pause = () => {};
w.eval(fs.readFileSync(root + 'app.js', 'utf8') + '\n;window.__t = { get noteDraft(){return noteDraft}, resetAccount };');
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
  // stale token -> back to sign-up with a message
  handlers['connect_error'](new Error('Authentication failed. Please create an account again.'));
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
