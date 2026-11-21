/* SyncPair client: real HTMLAudioElement playback + server-timestamped sync. */
const $ = selector => document.querySelector(selector);
const ICONS = {
  play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zm8 0h4v14h-4z', prev: 'M6 6h2v12H6zm3.5 6L18 18V6z', next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
  home: 'M12 3 3 11h2v9h5v-6h4v6h5v-9h2z', music: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3z', heart: 'M12 21s-8-4.9-9.6-9.7C1 7.700 3.400 4.500 6.600 4.500c2 0 3.700 1.100 5.400 3.100 1.700-2 3.400-3.100 5.400-3.100 3.200 0 5.600 3.200 4.200 6.800C20 16.100 12 21 12 21z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z', send: 'M2 21l21-9L2 3v7l15 2-15 2z',
  edit: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  spark: 'M12 2l2.4 6.6L21 11l-6.600 2.400L12 20l-2.400-6.600L3 11l6.600-2.400z'
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
const audio = $('#audio-player');
const me = { id: null, name: '', token: null, code: null };
let socket = null, partner = null, partnerState = null, partnerOnline = false;
let session = null, pendingInvite = null, lastControl = null;
let library = [], serverOffset = 0, isApplyingRemote = false;
let seekDragging = false, lastLocalControlAt = 0;
let lastCorrection = 0, wantPlaying = false, lastPlayCmd = 0, playRetries = 0;
let recent = [], lastRecent = { id: null, at: 0 };
let shared = { favorites: [], playlists: [], notes: [], roomName: '' }, queue = null, pendingItem = null, suggestion = null;
let shuffleOn = false, repeatMode = 'off', sleepDeadline = 0, sleepAtTrackEnd = false, sleepInterval = null;
let noteDraft = ''; // text typed in the note box; survives re-renders of the partner card

// Non-blocking message (replaces notify(), which freezes the page and the audio UI on phones).
let toastTimer = null;
function notify(message) {
  const box = $('#toast'); if (!box) return;
  box.textContent = String(message || ''); box.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.add('hidden'), 4500);
}

// ---- Link tracks: embedded players (YouTube/Spotify/SoundCloud) and a shared clock for apps without an API ----
const EMBED_PROVIDERS = ['youtube', 'spotify', 'soundcloud'];
const isEmbed = t => !!t && EMBED_PROVIDERS.includes(t.provider);
const isVirtual = t => t?.provider === 'other';
const isLinkTrack = t => isEmbed(t) || isVirtual(t);
const linkMeta = () => player.track?.provider ? { id: player.track.id, title: player.track.title, artist: player.track.artist, link: player.track.link || '' } : undefined;
const trackFromItem = item => ({ id: item.linkId, title: item.title, artist: item.artist || '', provider: item.provider, ref: item.ref, link: item.link || '', app: item.app || '', url: item.provider === 'audio' ? item.ref : '', durationMs: 0 });
const embed = { ready: null, state: { pos: 0, dur: 0, playing: false, at: 0 } };
const virt = { base: 0, start: 0, playing: false };
function ensureEmbed() {
  if (embed.ready) return embed.ready;
  embed.ready = new Promise(resolve => { embed.resolve = resolve; $('#embed-frame').src = '/embed.html'; });
  return embed.ready;
}
function embedSend(msg) { $('#embed-frame').contentWindow?.postMessage({ syncpairCmd: msg }, location.origin); }
window.addEventListener('message', e => {
  if (e.origin !== location.origin) return;
  const m = e.data?.syncpairEmbed; if (!m) return;
  if (m.t === 'ready') embed.resolve?.();
  else if (m.t === 'state') { embed.state = { pos: m.pos, dur: m.dur, playing: m.playing, at: Date.now() }; renderPlayer(); }
  else if (m.t === 'ended') {
    // Ignore spurious "ended" (seek past the end, a player reload): only skip when the song really reached its end.
    const d = player.duration();
    wantPlaying = false;
    if (!isApplyingRemote && d > 0 && player.pos() >= d - 3000) {
      if (sleepAtTrackEnd) { window.stopForSleep?.(); return; }
      safeLog('⏭ track ended, playing next'); autoAdvance();
    }
    else safeLog('ignored a false “ended” from the player');
  }
  else if (m.t === 'error') { $('#player-status').textContent = m.msg; $('#session-status').textContent = m.msg; }
});
function placeEmbed(restoreAfterMove = true) {
  const wrap = $('#embed-wrap');
  if (!wrap) return false;
  const sessionScreen = $('#screen-session');
  let parent, before;
  if (sessionScreen && !sessionScreen.classList.contains('hidden')) {
    parent = sessionScreen;
    before = $('#sess-title');
  } else {
    parent = document.querySelector('#screen-home .now-card');
    before = parent?.querySelector(':scope > .row');
  }
  if (!parent || !before || (wrap.parentElement === parent && wrap.nextElementSibling === before)) return false;

  // Moving an iframe between DOM parents can reload its browsing context in some browsers.
  // Recreate the local bridge and restore the current link track after the new frame is ready.
  parent.insertBefore(wrap, before);
  const track = player?.track;
  if (embed.ready) {
    const shouldRestore = restoreAfterMove && isEmbed(track);
    const position = shouldRestore ? Math.max(0, Math.round(player.pos())) : 0;
    const autoplay = shouldRestore && player.playing;
    // Release any in-flight load waiting on the old frame before replacing its bridge.
    embed.resolve?.();
    embed.ready = new Promise(resolve => { embed.resolve = resolve; });
    $('#embed-frame').src = '/embed.html?relocated=' + Date.now();
    if (shouldRestore) {
      embed.ready.then(() => {
        if (player.track?.id !== track.id) return;
        embedSend({ t: 'load', provider: track.provider, ref: track.ref, start: position, autoplay });
      });
    }
  }
  return true;
}
function showLinkUI(track) {
  const wrap = $('#embed-wrap'), other = $('#other-panel');
  wrap.classList.toggle('hidden', !isEmbed(track));
  $('#sess-art')?.classList.toggle('hidden', isEmbed(track)); // the video replaces the cover art
  wrap.classList.toggle('spotify', track?.provider === 'spotify');
  wrap.classList.toggle('soundcloud', track?.provider === 'soundcloud');
  wrap.classList.toggle('interactive', track?.provider === 'spotify'); // Spotify needs one tap inside its own player
  placeEmbed(false);
  other.classList.toggle('hidden', !isVirtual(track));
  if (isVirtual(track)) {
    $('#other-text').textContent = `${track.app || 'This app'} can’t be controlled from here. Open the song in your app and press play when the timer starts. Play and pause here cue your partner.`;
    $('#other-open').href = track.link; $('#other-open').textContent = `Open in ${track.app || 'app'}`;
  }
}
const player = {
  track: null,
  get playing() { return isEmbed(this.track) ? embed.state.playing : isVirtual(this.track) ? virt.playing : (!audio.paused && !audio.ended); },
  pos() {
    if (isEmbed(this.track)) return embed.state.pos + (embed.state.playing ? Date.now() - embed.state.at : 0);
    if (isVirtual(this.track)) return virt.base + (virt.playing ? Date.now() - virt.start : 0);
    return Math.max(0, (audio.currentTime || 0) * 1000);
  },
  duration() {
    if (isEmbed(this.track)) return embed.state.dur > 0 ? embed.state.dur : (this.track.durationMs || 0);
    if (isVirtual(this.track)) return this.track.durationMs || 0;
    return Number.isFinite(audio.duration) ? audio.duration * 1000 : (this.track?.durationMs || 0);
  },
  async load(track, positionMs = 0, autoplay = false) {
    wantPlaying = !!autoplay; lastPlayCmd = Date.now(); playRetries = 0;
    if (isLinkTrack(track)) {
      audio.pause(); this.track = track; showLinkUI(track);
      if (isEmbed(track)) {
        embed.state = { pos: positionMs, dur: 0, playing: false, at: Date.now() };
        await ensureEmbed();
        embedSend({ t: 'load', provider: track.provider, ref: track.ref, start: Math.max(0, positionMs), autoplay });
      } else {
        if (embed.ready) embedSend({ t: 'pause' });
        Object.assign(virt, { base: Math.max(0, positionMs), start: Date.now(), playing: !!autoplay });
      }
      renderPlayer(); return;
    }
    if (!track?.url) throw new Error('This track has no playable audio file.');
    if (embed.ready) embedSend({ t: 'pause' });
    showLinkUI(null);
    this.track = track;
    // Library files are private: send the account token with them. Never attach it to third-party URLs.
    const srcPath = track.url.startsWith('/music/') ? track.url + '?t=' + encodeURIComponent(me.token || '') : track.url;
    const nextSrc = new URL(srcPath, window.location.origin).href;
    if (audio.src !== nextSrc) {
      audio.src = nextSrc;
      audio.load();
    }
    await waitForMetadata();
    const duration = Number.isFinite(audio.duration) ? audio.duration * 1000 : track.durationMs;
    if (duration > 0) track.durationMs = duration;
    audio.currentTime = Math.min(Math.max(0, positionMs) / 1000, Number.isFinite(audio.duration) ? audio.duration : Infinity);
    renderPlayer();
    if (autoplay) await this.play();
  },
  async play() {
    wantPlaying = true; lastPlayCmd = Date.now(); markPlayed(this.track);
    if (isEmbed(this.track)) {
      embedSend({ t: 'play' }); $('#player-status').textContent = 'Playing from the shared link.';
      setTimeout(() => { if (isEmbed(player.track) && !embed.state.playing) $('#session-status').textContent = 'If nothing plays, tap ▶ once (browsers block auto-play). Spotify may need a tap on its own player.'; }, 3000);
      return;
    }
    if (isVirtual(this.track)) { if (!virt.playing) Object.assign(virt, { base: this.pos(), start: Date.now(), playing: true }); renderPlayer(); return; }
    try { await audio.play(); $('#player-status').textContent = 'Playing audio on this device.'; }
    catch (error) {
      $('#player-status').textContent = 'Tap Play to allow audio playback on this device.';
      $('#session-status').textContent = 'Tap Play once to enable synced audio on this device.';
      throw error;
    }
  },
  pause() {
    wantPlaying = false;
    if (isEmbed(this.track)) embedSend({ t: 'pause' });
    else if (isVirtual(this.track)) { Object.assign(virt, { base: this.pos(), playing: false }); renderPlayer(); }
    else audio.pause();
  },
  seek(ms) {
    if (!this.track) return;
    if (isEmbed(this.track)) { embedSend({ t: 'seek', ms: Math.max(0, ms) }); embed.state.pos = Math.max(0, ms); embed.state.at = Date.now(); return; }
    if (isVirtual(this.track)) { Object.assign(virt, { base: Math.max(0, ms), start: Date.now() }); return; }
    const max = Number.isFinite(audio.duration) ? audio.duration : (this.track.durationMs || 0) / 1000;
    audio.currentTime = Math.min(Math.max(0, ms / 1000), max || 0);
  },
};
function waitForMetadata() {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('This audio file could not be decoded by your browser.')); };
    const cleanup = () => { audio.removeEventListener('loadedmetadata', done); audio.removeEventListener('error', fail); };
    audio.addEventListener('loadedmetadata', done, { once: true });
    audio.addEventListener('error', fail, { once: true });
  });
}
function fmt(ms) { const s = Math.floor(Math.max(0, ms) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function artStyle(track) {
  let h = 0; for (const ch of String(track?.id || 'music')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `background:linear-gradient(135deg,hsl(${h},70%,55%),hsl(${(h + 50) % 360},70%,38%));`;
}
function show(id) { document.querySelectorAll('.screen').forEach(e => e.classList.add('hidden')); $(id).classList.remove('hidden'); placeEmbed(); }
function safeLog(message, strongPrefix = '') {
  const log = $('#log'); if (!log) return;
  const line = document.createElement('div');
  if (strongPrefix) { const b = document.createElement('b'); b.textContent = strongPrefix; line.append(b, document.createTextNode(message)); }
  else line.textContent = message;
  log.append(line); log.scrollTop = log.scrollHeight;
}
async function createAccount(name) {
  const response = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not create account.'); return data;
}
function connectMine(token) {
  socket = io({ auth: { token } });
  socket.on('connect', () => { refreshShared(); socket.emit('recent:get', {}, r => { if (r?.ok) { recent = r.recent; renderRecent(); } }); });
  socket.on('library:changed', () => refreshLibrary().catch(() => {}));
  socket.on('recent:update', r => { recent = r.recent || []; renderRecent(); });
  socket.on('shared:update', st => { shared = { favorites: st.favorites || [], playlists: st.playlists || [], notes: st.notes || [], roomName: st.roomName || '' }; renderShared(); renderLibrary(); renderPartnerCard(); });
  socket.on('track:suggest', s => { suggestion = s; renderSuggestBanner(); });
  socket.on('connect_error', err => {
    // The server no longer knows this token (data reset, or a different server). Retrying can never work, so
    // return to sign-up instead of leaving the person on a pair screen that silently does nothing.
    if (/^Authentication failed/i.test(err.message || '')) { resetAccount('Your saved account was not found on this server (it may have been reset). Create a new account to continue.'); return; }
    $('#upload-status').textContent = err.message;
  });
  socket.on('clock:sync', ({ serverTime }) => { serverOffset = serverTime - Date.now(); });
  socket.on('partner:info', p => { partner = p; partnerOnline = !!p.online; renderHome(); refreshShared(); });
  socket.on('partner:presence', ({ online }) => { partnerOnline = !!online; renderPresence(); renderPartnerCard(); });
  socket.on('partner:state', st => { partnerState = st; renderPartnerNow(); });
  socket.on('session:invite', ({ session: incoming, from, item }) => { pendingInvite = incoming; pendingItem = item || null; refreshLibrary().catch(() => {}); renderInviteBanner(from); });
  socket.on('session:started', ({ session: started }) => { session = started; pendingInvite = null; pendingItem = null; enterSession(); });
  socket.on('session:resume', ({ session: resumed }) => { session = resumed; enterSession(); });
  socket.on('session:ended', () => { session = null; pendingInvite = null; lastControl = null; show('#screen-home'); renderHome(); });
  socket.on('session:control', applyControl);
  socket.on('session:peer-joined', () => {
    if (!player.track) return;
    socket.emit('session:control', { type: player.playing ? 'play' : 'pause', trackId: player.track.id, track: linkMeta(), positionMs: Math.round(player.pos()) });
  });
  socket.on('react', r => { floatEmoji(r.emoji); safeLog(`${r.from} reacted ${r.emoji} at ${fmt(r.positionMs)}`); });
  socket.on('chat', m => safeLog(m.text, `${m.from}: `));
}
function resetAccount(message) {
  try { localStorage.removeItem('syncpair-account'); } catch {}
  socket?.close(); socket = null;
  Object.assign(me, { id: null, name: '', token: null, code: null });
  partner = null; partnerState = null; partnerOnline = false; session = null; pendingInvite = null; library = []; noteDraft = '';
  $('#create-box').classList.remove('hidden'); $('#pair-box').classList.add('hidden');
  const status = $('#pair-status'); status.textContent = message || ''; status.classList.toggle('hidden', !message);
  show('#screen-pair');
}
function renderPresence() {
  const dot = $('#presence'); if (dot) dot.className = 'dot' + (partnerOnline ? ' on' : '');
}
function renderHome() {
  $('#me-name').textContent = me.name;
  renderPresence(); renderPartnerCard(); renderPlayer(); renderInviteBanner();
  show('#screen-home');
}
function renderPartnerCard() {
  const card = $('#partner-card');
  // This card is rebuilt on every presence/shared update. Keep what the person is typing (and the caret).
  const oldInput = card.querySelector('.profile-note-composer textarea');
  const hadFocus = !!oldInput && document.activeElement === oldInput;
  const caret = oldInput ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
  if (oldInput) noteDraft = oldInput.value;
  card.replaceChildren();
  if (!partner) {
    const p = document.createElement('p'); p.className = 'dim';
    p.textContent = 'Pair with your partner using their code to start leaving little notes.';
    card.append(p); return;
  }

  const top = document.createElement('div'); top.className = 'profile-heading';
  const avatar = document.createElement('div'); avatar.className = 'profile-avatar';
  avatar.textContent = (partner.name || '?').trim().slice(0, 1).toUpperCase();
  const details = document.createElement('div'); details.className = 'profile-identity';
  const eyebrow = document.createElement('span'); eyebrow.className = 'profile-eyebrow'; eyebrow.textContent = 'YOUR PERSON';
  const heading = document.createElement('h3'); heading.textContent = partner.name;
  const status = document.createElement('p'); status.className = 'dim small profile-status';
  status.innerHTML = `<span class="dot ${partnerOnline ? 'on' : ''}"></span> ${partnerOnline ? 'Around right now' : 'A little away'}`;
  details.append(eyebrow, heading, status); top.append(avatar, details);
  card.append(top);

  const nowSlot = document.createElement('div'); nowSlot.className = 'profile-now-slot'; card.append(nowSlot);
  renderPartnerNow();

  const wall = document.createElement('section'); wall.className = 'profile-note-wall';
  const wallHead = document.createElement('div'); wallHead.className = 'profile-wall-heading';
  const wallTitle = document.createElement('div');
  const title = document.createElement('h4'); title.textContent = 'Little notes';
  const subtitle = document.createElement('p'); subtitle.className = 'dim small'; subtitle.textContent = 'Leave something sweet on their profile.';
  wallTitle.append(title, subtitle);
  const count = document.createElement('span'); count.className = 'profile-note-count';
  count.textContent = `${(shared.notes || []).length} ♡`;
  wallHead.append(wallTitle, count); wall.append(wallHead);

  const composer = document.createElement('div'); composer.className = 'profile-note-composer';
  const input = document.createElement('textarea');
  input.maxLength = 280; input.rows = 2; input.value = noteDraft;
  input.addEventListener('input', () => { noteDraft = input.value; });
  input.placeholder = 'A tiny reminder, an inside joke, or just “thinking of you”…';
  input.setAttribute('aria-label', 'Write a note for your partner');
  const composeFoot = document.createElement('div'); composeFoot.className = 'profile-note-compose-foot';
  const hint = document.createElement('span'); hint.className = 'dim small'; hint.textContent = '280 characters · just between you two';
  const send = document.createElement('button'); send.className = 'primary mini'; send.textContent = 'Leave a note ♡';
  send.onclick = () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    send.disabled = true;
    socket.emit('note:add', { text }, result => {
      send.disabled = false;
      if (!result?.ok) { notify(result?.error || 'Could not leave your note.'); return; }
      input.value = ''; noteDraft = '';
      input.placeholder = 'Your note is on their profile ♡';
    });
  };
  composeFoot.append(hint, send); composer.append(input, composeFoot); wall.append(composer);

  const notes = document.createElement('div'); notes.className = 'profile-notes';
  const ordered = [...(shared.notes || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!ordered.length) {
    const empty = document.createElement('p'); empty.className = 'profile-notes-empty';
    empty.textContent = 'No little notes yet. You could leave the first one ✧';
    notes.append(empty);
  } else {
    ordered.forEach((note, index) => {
      const item = document.createElement('article'); item.className = `sticky-note sticky-note-${index % 3}`;
      const noteText = document.createElement('p'); noteText.textContent = note.text;
      const meta = document.createElement('div'); meta.className = 'sticky-note-meta';
      const by = document.createElement('span'); by.textContent = `♡ ${note.fromName || 'Someone special'}`;
      const when = document.createElement('time');
      when.textContent = note.createdAt ? new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      meta.append(by, when); item.append(noteText, meta);
      if (note.fromId === me.id) {
        const remove = document.createElement('button'); remove.className = 'note-delete'; remove.textContent = '×';
        remove.title = 'Remove your note'; remove.setAttribute('aria-label', 'Remove your note');
        remove.onclick = () => socket.emit('note:delete', { id: note.id }, result => {
          if (!result?.ok) notify(result?.error || 'Could not remove note.');
        });
        item.append(remove);
      }
      notes.append(item);
    });
  }
  wall.append(notes); card.append(wall);

  if (partner && !session) {
    const button = document.createElement('button'); button.className = 'primary profile-listen-btn';
    button.textContent = '♡ Listen together'; button.onclick = startSession; card.append(button);
  }
  if (hadFocus) { input.focus(); try { input.setSelectionRange(caret[0], caret[1]); } catch {} }
}
// The partner's "in their headphones" block is refreshed in place (it changes every few seconds), so typing a
// note is never interrupted by the partner's playback updates.
function renderPartnerNow() {
  const slot = $('#partner-card .profile-now-slot'); if (!slot) return;
  slot.replaceChildren();
  if (!partnerState?.track) return;
  const now = document.createElement('div'); now.className = 'profile-now-playing';
  const kicker = document.createElement('span'); kicker.className = 'profile-eyebrow'; kicker.textContent = 'IN THEIR HEADPHONES';
  const row = document.createElement('div'); row.className = 'row partner-track';
  const art = document.createElement('div'); art.className = 'art'; art.style.cssText = artStyle(partnerState.track);
  const info = document.createElement('div'); info.className = 'profile-track-info';
  const title = document.createElement('b'); title.textContent = partnerState.track.title;
  const artist = document.createElement('p'); artist.className = 'dim small'; artist.textContent = partnerState.track.artist;
  const playing = document.createElement('p'); playing.className = 'small ' + (partnerState.isPlaying ? 'live' : 'dim');
  playing.textContent = partnerState.isPlaying ? '♫ Listening now' : 'Ⅱ Taking a pause';
  info.append(title, artist, playing); row.append(art, info); now.append(kicker, row); slot.append(now);
}
function renderInviteBanner(from) {
  const banner = $('#invite-banner'); banner.replaceChildren();
  if (!pendingInvite) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const message = document.createElement('p'); const who = from?.name || partner?.name || 'Your partner';
  message.textContent = pendingItem ? `${who} invited you to listen to “${pendingItem.title}”.` : `${who} invited you to listen together.`;
  const join = document.createElement('button'); join.className = 'primary'; join.textContent = 'Join session';
  join.onclick = () => socket.emit('session:join', { id: pendingInvite.id }, result => { if (!result?.ok) notify(result?.error || 'Could not join session.'); });
  banner.append(message, join);
}
let lastRenderKey = '';
function renderPlayer(force = false) {
  const track = player.track;
  if (!track) return;
  const key = `${track.id}|${player.playing}|${Math.round(player.duration() / 1000)}`;
  if (!force && key === lastRenderKey) return;
  lastRenderKey = key;
  $('#me-art').style.cssText = artStyle(track); $('#me-title').textContent = track.title; $('#me-artist').textContent = track.artist;
  $('#sess-title').textContent = track.title; $('#sess-artist').textContent = track.artist;
  const pi = icon(player.playing ? 'pause' : 'play'); $('#me-play').innerHTML = pi; $('#s-play').innerHTML = pi;
  $('#me-play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play'); $('#s-play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  $('#sess-art').style.cssText = artStyle(track);
  const duration = player.duration();
  $('#me-duration').textContent = fmt(duration); $('#sess-duration').textContent = fmt(duration);
  updateMediaSession(track);
}
// Lets the lock screen, Bluetooth headphones and car displays show the song and control playback. Because these
// go through the same togglePlay/skip/broadcast functions, they stay synchronized with the partner too.
let mediaKey = '';
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const key = `${track.id}|${track.title}|${track.artist}`;
  if (key !== mediaKey) {
    mediaKey = key;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.title || 'SyncPair', artist: track.artist || '', album: 'SyncPair' }); } catch {}
  }
  navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
}
(function initMediaSessionActions() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} };
  set('play', () => { if (!player.playing) togglePlay(); });
  set('pause', () => { if (player.playing) togglePlay(); });
  set('previoustrack', () => skip(-1));
  set('nexttrack', () => skip(1));
  set('seekto', d => { if (player.track && Number.isFinite(d?.seekTime)) { player.seek(d.seekTime * 1000); broadcast('seek'); } });
})();
function renderLibrary() {
  const list = $('#library-list'); list.replaceChildren();
  $('#track-count').textContent = `${library.length} ${library.length === 1 ? 'track' : 'tracks'}`;
  if (!library.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'Your library is empty. Upload an audio file to get started.'; list.append(p); return; }
  const term = ($('#library-search')?.value || '').trim().toLowerCase();
  const sort = $('#library-sort')?.value || 'added';
  const visible = library.filter(t => !term || `${t.title} ${t.artist || ''}`.toLowerCase().includes(term));
  visible.sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'artist' ? (a.artist||'').localeCompare(b.artist||'') : sort === 'duration' ? (b.durationMs||0)-(a.durationMs||0) : 0);
  if (!visible.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = term ? 'No songs match your search.' : 'Your library is empty.'; list.append(p); return; }
  visible.forEach(track => {
    const row = document.createElement('div'); row.className = 'library-row';
    const thumb = document.createElement('div'); thumb.className = 'art'; thumb.style.cssText = artStyle(track);
    const details = document.createElement('div'); details.className = 'track-info';
    const title = document.createElement('b'); title.textContent = track.title;
    const artist = document.createElement('p'); artist.className = 'dim small'; artist.textContent = `${track.artist} · ${fmt(track.durationMs || 0)}`;
    details.append(title, artist);
    const play = document.createElement('button'); play.textContent = player.track?.id === track.id ? 'Selected' : 'Play'; play.className = player.track?.id === track.id ? 'selected' : '';
    play.onclick = () => { queue = null; selectTrack(track, true); };
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const item = { trackId: track.id };
    const menu = document.createElement('div'); menu.className = 'row-more hidden';
    const item2 = (name, label, fn) => { const b = document.createElement('button'); b.className = 'mini wide'; b.innerHTML = icon(name) + '<span></span>'; b.lastChild.textContent = label; b.onclick = () => { menu.classList.add('hidden'); fn(); }; return b; };
    menu.append(item2('plus', 'Playlist', () => addToPlaylist(item)), item2('send', 'Invite', () => inviteToListen(item)), item2('edit', 'Edit', () => editTrack(track)), ...(track.mine ? [item2('trash', 'Delete', () => deleteTrack(track))] : []));
    const more = mini('more', 'More actions', () => { const open = menu.classList.toggle('hidden'); more.setAttribute('aria-expanded', String(!open)); });
    more.setAttribute('aria-expanded', 'false');
    actions.append(mini(isFav(item) ? '♥' : '♡', 'Favorite together', () => toggleFav(item)), more, play);
    row.classList.add('has-menu');
    row.append(thumb, details, actions, menu); list.append(row);
  });
}
async function refreshLibrary() {
  if (!me.token) return;
  const response = await fetch('/api/library', { headers: { Authorization: 'Bearer ' + me.token } }); if (!response.ok) throw new Error('Could not load music library.');
  library = await response.json(); renderLibrary();
  const cur = player.track && !player.track.provider ? library.find(t => t.id === player.track.id) : null;
  if (cur) { player.track.title = cur.title; player.track.artist = cur.artist; renderPlayer(true); }
}
async function libraryRequest(track, method, body) {
  const response = await fetch('/api/library/' + encodeURIComponent(track.id), { method, headers: { Authorization: 'Bearer ' + me.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
async function editTrack(track) {
  const title = prompt('Song title', track.title); if (title === null) return;
  const artist = prompt('Artist', track.artist === 'Unknown artist' ? '' : track.artist); if (artist === null) return;
  try { await libraryRequest(track, 'PATCH', { title, artist }); await refreshLibrary(); } catch (error) { $('#upload-status').textContent = error.message; }
}
async function deleteTrack(track) {
  if (!confirm(`Delete “${track.title}” for both of you? This also removes it from favorites and playlists.`)) return;
  try {
    await libraryRequest(track, 'DELETE');
    if (queue) queue = queue.filter(t => t.id !== track.id);
    if (player.track?.id === track.id) player.pause();
    await refreshLibrary(); $('#upload-status').textContent = `Deleted ${track.title}.`;
  } catch (error) { $('#upload-status').textContent = error.message; }
}
async function inspectDuration(file) {
  const url = URL.createObjectURL(file); const probe = new Audio(); probe.preload = 'metadata'; probe.src = url;
  try {
    await new Promise((resolve, reject) => { probe.onloadedmetadata = resolve; probe.onerror = () => reject(new Error(`Cannot read audio metadata for ${file.name}`)); });
    return Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0;
  } finally { URL.revokeObjectURL(url); }
}
async function uploadFiles(files) {
  const status = $('#upload-status');
  for (const file of files) {
    try {
      status.textContent = `Reading ${file.name}…`;
      const durationMs = await inspectDuration(file);
      status.textContent = `Uploading ${file.name}…`;
      const response = await fetch('/api/library', { method: 'POST', headers: {
        'Authorization': 'Bearer ' + me.token,
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-Track-Title': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')),
        'X-Track-Artist': encodeURIComponent('Unknown artist'),
        'X-Track-Duration-Ms': String(durationMs),
      }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.');
      if (!library.some(t => t.id === result.id)) library.push(result); renderLibrary(); status.textContent = `Added ${result.title}.`;
    } catch (error) { status.textContent = error.message; }
  }
  $('#audio-file').value = '';
}
async function selectTrack(track, autoplay = false, positionMs = 0) {
  try {
    await player.load(track, positionMs, autoplay);
    renderPlayer(); renderLibrary();
    if (autoplay) broadcast('skip'); else publishState();
  } catch (error) { $('#player-status').textContent = error.message; }
}
function currentIndex() { return library.findIndex(t => t.id === player.track?.id); }
async function skip(direction) {
  const list = queue?.length ? queue : library;
  if (!list.length) { $('#player-status').textContent = 'Upload music before playing.'; return; }
  const index = list.findIndex(t => t.id === player.track?.id);
  if (direction > 0 && repeatMode === 'one' && index >= 0) return selectTrack(list[index], true);
  if (direction > 0 && repeatMode === 'off' && !shuffleOn && index === list.length - 1) { player.pause(); player.seek(0); renderPlayer(true); $('#player-status').textContent = 'Playlist finished.'; return; }
  let next;
  if (shuffleOn && list.length > 1 && direction > 0) {
    const choices = list.map((_, i) => i).filter(i => i !== index);
    next = choices[Math.floor(Math.random() * choices.length)];
  } else next = (index < 0 ? 0 : (index + direction + list.length) % list.length);
  await selectTrack(list[next], true);
}
// When a song ends during a session, both phones used to advance on their own. With shuffle on they picked
// different random songs and then swapped tracks with each other. Now only the session leader (whoever
// started it) advances and tells the partner; the follower steps in only if nothing arrives.
function autoAdvance() {
  if (!session || session.a === me.id) return skip(1);
  const ended = player.track?.id;
  setTimeout(() => { if (session && player.track?.id === ended && !player.playing) skip(1); }, 3500);
}
// The README promises a leader heartbeat; nothing sent it. It keeps both clocks anchored and lets a phone that
// missed a command (brief disconnect, locked screen) catch up on its own.
setInterval(() => {
  if (!session || session.a !== me.id || !socket?.connected || !player.track || !player.playing) return;
  socket.emit('session:control', { type: 'sync', trackId: player.track.id, track: linkMeta(), positionMs: Math.round(player.pos()), isPlaying: true });
}, 5000);
function publishState() {
  if (!player.track || !socket?.connected) return;
  socket.emit('state:update', { trackId: player.track.id, track: linkMeta(), positionMs: Math.round(player.pos()), isPlaying: player.playing });
}
function broadcast(type) {
  if (!player.track) return;
  const payload = { type, trackId: player.track.id, track: linkMeta(), positionMs: Math.round(player.pos()) };
  publishState();
  if (session && socket?.connected) {
    lastLocalControlAt = Date.now();
    lastControl = { ...payload, serverTime: Date.now() + serverOffset };
    socket.emit('session:control', payload);
  }
}
async function togglePlay() {
  if (!player.track) { if (library.length) await selectTrack(library[0], true); else $('#player-status').textContent = 'Upload music before playing.'; return; }
  if (player.playing) { player.pause(); broadcast('pause'); }
  else { try { await player.play(); broadcast('play'); } catch { /* status is displayed by player.play */ } }
  renderPlayer();
}
async function seekFromRange(range) {
  if (!player.track) return;
  const duration = player.duration();
  player.seek(duration * Number(range.value) / 1000); broadcast('seek');
}
async function applyControl(control) {
  const track = library.find(t => t.id === control.trackId) || control.track;
  if (!track?.url && !track?.provider) { $('#session-status').textContent = 'This track is not in the shared library on this server.'; return; }
  if (control.type === 'sync' && player.track?.id === track.id) { // heartbeat: update reference clock only
    lastControl = control;
    if (control.isPlaying && !player.playing && !wantPlaying && Date.now() - lastLocalControlAt > 2500) { try { await player.play(); } catch {} } // not right after the user's own pause
    return;
  }
  isApplyingRemote = true;
  const elapsed = Math.max(0, Date.now() + serverOffset - control.serverTime);
  const moving = control.type === 'play' || control.type === 'skip' || (control.type === 'sync' && control.isPlaying);
  const position = control.positionMs + (moving ? elapsed : 0);
  try {
    if (player.track?.id !== track.id) await player.load(track, position, false);
    player.seek(control.positionMs + (moving ? Math.max(0, Date.now() + serverOffset - control.serverTime) : 0));
    if (control.type === 'pause') player.pause();
    else if (moving) await player.play();
    lastControl = control;
    $('#session-status').textContent = `Synced with ${control.fromName || 'your partner'}.`;
    safeLog(`↔ ${control.type}: ${track.title} · ${fmt(position)}`);
    renderPlayer(); renderLibrary();
  } catch (error) { $('#session-status').textContent = error.message + ' Tap Play to enable audio.'; }
  finally { isApplyingRemote = false; }
}
function startSession() { socket.emit('session:start', {}, result => { if (!result?.ok) notify(result?.error || 'Could not start session.'); }); }
function enterSession() {
  show('#screen-session');
  renderPlayer(true); safeLog('🎧 Listening session connected.');
}
function floatEmoji(emoji) {
  const wrap = $('#floaters'); const item = document.createElement('div'); item.className = 'floater'; item.textContent = emoji;
  item.style.left = (20 + Math.random() * 60) + '%'; wrap.append(item); setTimeout(() => item.remove(), 2200);
}
function sendChat() {
  const input = $('#chat-inp'); const text = input.value.trim(); if (!text) return;
  socket.emit('chat', { text }); safeLog(text, `${me.name}: `); input.value = '';
}

// Playback events: native audio element is the source of truth for position and duration.
function updateProgress() {
  if (!player.track) return;
  const duration = player.duration();
  const pos = player.pos(); const pct = duration > 0 ? Math.min(100, pos / duration * 100) : 0;
  $('#me-prog').style.width = pct + '%'; $('#sess-prog').style.width = pct + '%';
  $('#me-time').textContent = fmt(pos); $('#sess-time').textContent = `${fmt(pos)} / ${fmt(duration)}`;
  if (!seekDragging) { const value = duration > 0 ? Math.round(pos / duration * 1000) : 0; $('#me-seek').value = value; $('#sess-seek').value = value; }
}
audio.preload = 'auto';
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('waiting', () => { if (player.track && !isLinkTrack(player.track)) $('#session-status').textContent = 'Buffering…'; });
audio.addEventListener('playing', () => { if (session) $('#session-status').textContent = 'Synced listening session'; });
setInterval(() => { if (isLinkTrack(player.track)) updateProgress(); }, 500);
audio.addEventListener('play', () => { renderPlayer(); });
audio.addEventListener('pause', () => { renderPlayer(); });
audio.addEventListener('loadedmetadata', renderPlayer);
audio.addEventListener('ended', () => { if (sleepAtTrackEnd) { stopForSleep(); return; } if (!isApplyingRemote) autoAdvance(); });
audio.addEventListener('error', () => { if (player.track) $('#player-status').textContent = 'Audio could not be played. Try converting it to MP3 or AAC.'; });

setInterval(() => {
  // Browsers refuse to auto-play until the person has tapped/clicked this page at least once (e.g. after a reload).
  const noGesture = !!navigator.userActivation && !navigator.userActivation.hasBeenActive;
  const waiting = !!player.track && !isVirtual(player.track) && wantPlaying && !player.playing;
  const stalled = waiting && Date.now() - lastPlayCmd > 2500;
  if (player.playing) playRetries = 0;
  if (stalled && !noGesture && playRetries < 3) { playRetries++; lastPlayCmd = Date.now(); if (isEmbed(player.track)) embedSend({ t: 'play' }); else audio.play().catch(() => {}); safeLog(`↻ player was not playing, retrying (${playRetries}/3)`); }
  $('#tap-play').classList.toggle('hidden', !(waiting && (noGesture || playRetries >= 1))); // a real tap always unlocks playback
  if (session && player.playing && lastControl && lastControl.type !== 'pause') {
    const expected = lastControl.positionMs + Math.max(0, Date.now() + serverOffset - lastControl.serverTime);
    const drift = expected - player.pos();
    if (Math.abs(drift) > (isLinkTrack(player.track) ? 2000 : 750) && Date.now() - lastCorrection > 5000) { lastCorrection = Date.now(); player.seek(expected); safeLog(`↻ corrected playback drift (${Math.round(drift)} ms)`); }
  }
}, 500);
setInterval(() => { if (socket?.connected) { publishState(); socket.emit('clock:sync'); } }, 5000);

$('#btn-create').onclick = async () => {
  try {
    const account = await createAccount($('#inp-name').value.trim() || 'Listener');
    Object.assign(me, { id: account.userId, name: account.name, token: account.token, code: account.code });
    localStorage.setItem('syncpair-account', JSON.stringify(me));
    $('#my-code').textContent = me.code; $('#create-box').classList.add('hidden'); $('#pair-box').classList.remove('hidden');
    connectMine(me.token); await refreshLibrary();
  } catch (error) { notify(error.message); }
};
$('#btn-join-code').onclick = () => {
  if (!socket?.connected) return notify('Connecting to SyncPair. Please try again in a moment.');
  socket.emit('pair:accept', { code: $('#inp-code').value.trim().toUpperCase() }, result => {
    if (!result?.ok) notify(result?.error || 'Pairing failed.'); else { partner = result.partner; partnerOnline = !!result.partner.online; renderHome(); }
  });
};
$('#audio-file').addEventListener('change', event => uploadFiles([...event.target.files]));
$('#me-play').onclick = $('#s-play').onclick = togglePlay;
$('#me-next').onclick = $('#s-next').onclick = () => skip(1);
$('#me-prev').onclick = $('#s-prev').onclick = () => skip(-1);
$('#me-seek').addEventListener('input', () => { seekDragging = true; });
$('#sess-seek').addEventListener('input', () => { seekDragging = true; });
$('#me-seek').addEventListener('change', async () => { seekDragging = false; await seekFromRange($('#me-seek')); });
$('#sess-seek').addEventListener('change', async () => { seekDragging = false; $('#me-seek').value = $('#sess-seek').value; await seekFromRange($('#sess-seek')); });
$('#btn-leave').onclick = () => socket?.emit('session:leave');
const EMOJIS = ['❤️', '🔥', '👏', '😭', '🎧'];
EMOJIS.forEach(emoji => { const button = document.createElement('button'); button.textContent = emoji; button.onclick = () => { socket.emit('react', { emoji, positionMs: Math.round(player.pos()) }); floatEmoji(emoji); }; $('#reactions').append(button); });
$('#chat-send').onclick = sendChat; $('#chat-inp').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });


// ---- Favorites, playlists, invitations, sharing from any player ----
const keyOf = i => i.trackId || ('ext:' + ((i.title || '').trim() + '|' + (i.artist || '').trim()).toLowerCase());
const isFav = i => shared.favorites.some(f => f.key === keyOf(i));
function mini(text, title, onclick) { const b = document.createElement('button'); b.className = 'mini'; if (ICONS[text]) b.innerHTML = icon(text); else b.textContent = text; b.title = title; b.setAttribute('aria-label', title); b.onclick = onclick; return b; }
function refreshShared() { if (!socket?.connected) return; socket.emit('shared:get', {}, r => { if (r?.ok) { shared = { favorites: r.favorites || [], playlists: r.playlists || [], notes: r.notes || [], roomName: r.roomName || '' }; renderShared(); renderLibrary(); renderPartnerCard(); } }); }
function toggleFav(item) { socket.emit('fav:toggle', { item }, r => { if (!r?.ok) notify(r?.error || 'Could not update favorites.'); }); }
function inviteToListen(item) {
  socket.emit('track:invite', { item }, r => {
    if (!r?.ok) return notify(r?.error || 'Could not send.');
    const it = r.item || item;
    const t = it.trackId ? library.find(x => x.id === it.trackId) : (it.provider ? trackFromItem(it) : null);
    if (t) selectTrack(t, true); else $('#upload-status').textContent = `Sent to ${partner?.name || 'your partner'}.`;
  });
}
let playlistPendingItem = null;
function closePlaylistPicker() { $('#playlist-picker').classList.add('hidden'); playlistPendingItem = null; }
function addToPlaylist(item) {
  if (!socket?.connected) { $('#upload-status').textContent = 'Reconnecting… please try again in a moment.'; return; }
  playlistPendingItem = item;
  const track = item.trackId ? library.find(t => t.id === item.trackId) : item;
  $('#playlist-picker-song').textContent = track ? `Song: ${track.title}${track.artist ? ' · ' + track.artist : ''}` : 'Choose where to save this song.';
  $('#playlist-picker-status').textContent = '';
  renderPlaylistPicker();
  $('#playlist-picker').classList.remove('hidden');
}
function renderPlaylistPicker() {
  const box = $('#playlist-picker-options'); box.replaceChildren();
  if (!shared.playlists.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'You don’t have a playlist yet. Create one below.'; box.append(p); return; }
  shared.playlists.forEach(pl => {
    const b = document.createElement('button'); b.className = 'playlist-choice';
    const duplicate = playlistPendingItem && pl.items.some(x => x.key === keyOf(playlistPendingItem));
    b.disabled = !!duplicate;
    b.innerHTML = `<span></span><span></span>`;
    b.children[0].textContent = pl.name;
    b.children[1].textContent = duplicate ? 'Already added' : `${pl.items.length} songs · Add`;
    b.onclick = () => {
      if (!playlistPendingItem) return;
      b.disabled = true; $('#playlist-picker-status').textContent = 'Adding song…';
      socket.emit('playlist:add', { id: pl.id, item: playlistPendingItem }, r => {
        if (!r?.ok) { $('#playlist-picker-status').textContent = r?.error || 'Could not add this song.'; b.disabled = false; return; }
        $('#playlist-picker-status').textContent = `Added to “${pl.name}” ♥`;
        refreshShared(); setTimeout(closePlaylistPicker, 650);
      });
    };
    box.append(b);
  });
}
function newPlaylist() {
  const name = (prompt('Playlist name') || '').trim(); if (!name) return;
  if (!socket?.connected) { notify('Reconnecting… please try again.'); return; }
  socket.emit('playlist:create', { name }, r => {
    if (!r?.ok) { notify(r?.error || 'Could not create playlist.'); return; }
    refreshShared();
    if (playlistPendingItem) {
      socket.emit('playlist:add', { id: r.playlist.id, item: playlistPendingItem }, result => {
        if (!result?.ok) { $('#playlist-picker-status').textContent = result?.error || 'Playlist created, but song was not added.'; return; }
        $('#playlist-picker-status').textContent = `Created “${r.playlist.name}” and added the song ♥`;
        refreshShared(); setTimeout(closePlaylistPicker, 700);
      });
    }
  });
}
// A playlist can mix uploaded songs and shared links. Link songs with an embedded player (YouTube, Spotify,
// SoundCloud) or a direct audio URL play too; "open in another app" songs have no end event, so they cannot
// sit in an auto-advancing queue and are skipped here (they still have their own 🎧 button).
function playableFromItem(item) {
  if (item.trackId) return library.find(t => t.id === item.trackId) || null;
  if (item.provider && item.provider !== 'other' && item.linkId) return trackFromItem(item);
  return item.provider ? null : (findInLibrary(item) || null);
}
function playItems(items, { shuffle = false } = {}) {
  const ts = items.map(playableFromItem).filter(Boolean);
  if (!ts.length) { $('#upload-status').textContent = 'No playable tracks here yet.'; return; }
  if (shuffle) for (let i = ts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ts[i], ts[j]] = [ts[j], ts[i]]; }
  const skipped = items.length - ts.length;
  if (skipped > 0) $('#upload-status').textContent = `Playing ${ts.length} of ${items.length} songs (${skipped} can only be opened in another app).`;
  queue = ts; selectTrack(ts[0], true);
}
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function findInLibrary(item) {
  if (item.trackId) return library.find(t => t.id === item.trackId);
  const n = norm(item.title); if (!n) return null;
  return library.find(t => { const m = norm(t.title); return m === n || (n.length >= 3 && m.length >= 3 && (m.includes(n) || n.includes(m))); });
}
async function uploadWithMeta(file, meta) {
  const durationMs = await inspectDuration(file);
  const response = await fetch('/api/library', { method: 'POST', headers: {
    'Authorization': 'Bearer ' + me.token, 'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name), 'X-Track-Title': encodeURIComponent(meta.title),
    'X-Track-Artist': encodeURIComponent(meta.artist || 'Unknown artist'), 'X-Track-Duration-Ms': String(durationMs) }, body: file });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.');
  if (!library.some(t => t.id === result.id)) library.push(result); renderLibrary(); return result;
}
// A song shared from another player has no audio here: play it from the library if both have it, else add the file once.
function listenTogether(item) {
  const t = findInLibrary(item);
  if (t) return inviteToListen({ trackId: t.id });
  if (item.provider) return inviteToListen(item); // play straight from the shared link (embedded player, or shared clock + open-in-app)
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.webm';
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    try { $('#upload-status').textContent = `Uploading ${item.title}…`; const r = await uploadWithMeta(f, item); inviteToListen({ trackId: r.id }); }
    catch (e) { notify(e.message); }
  };
  input.click();
}
function searchLinks(item) {
  const q = encodeURIComponent(`${item.title} ${item.artist || ''}`.trim());
  return [['Spotify', `https://open.spotify.com/search/${q}`], ['YouTube Music', `https://music.youtube.com/search?q=${q}`]];
}
function itemRow(item, extra = []) {
  const row = document.createElement('div'); row.className = 'library-row';
  const thumb = document.createElement('div'); thumb.className = 'art'; thumb.style.cssText = artStyle({ id: item.trackId || item.key || item.title });
  const info = document.createElement('div'); info.className = 'track-info';
  const t = document.createElement('b'); t.textContent = item.title;
  const a = document.createElement('p'); a.className = 'dim small'; a.textContent = item.artist || (item.trackId ? '' : 'Shared from another player');
  info.append(t, a);
  const actions = document.createElement('div'); actions.className = 'row-actions';
  if (item.trackId || (item.provider && item.provider !== 'other')) actions.append(mini('▶', 'Play', () => playItems([item])));
  if (!item.trackId) {
    actions.append(mini('🎧', 'Listen together', () => listenTogether(item)));
    if (item.link) { const l = document.createElement('a'); l.href = item.link; l.target = '_blank'; l.rel = 'noopener noreferrer'; l.textContent = '↗'; l.className = 'mini'; actions.append(l); }
  }
  actions.append(mini('send', 'Invite partner', () => inviteToListen(item)), ...extra);
  row.append(thumb, info, actions); return row;
}
// Records a song in "Recently played" once per listen (not on every pause/resume).
function markPlayed(track) {
  if (!track?.id || !socket?.connected) return;
  const now = Date.now();
  if (lastRecent.id === track.id && now - lastRecent.at < 30 * 60 * 1000) return;
  lastRecent = { id: track.id, at: now };
  const item = track.provider ? { title: track.title, artist: track.artist, link: track.link || track.ref } : { trackId: track.id, title: track.title, artist: track.artist };
  socket.emit('recent:add', { item });
}
function renderRecent() {
  const box = $('#recent-list'); if (!box) return; box.replaceChildren();
  if (!recent.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'Songs you listen to will show up here.'; box.append(p); return; }
  recent.forEach(item => {
    const faved = shared.favorites.some(f => f.key === item.key);
    box.append(itemRow(item, [mini(faved ? '♥' : '♡', faved ? 'Remove from favorites' : 'Add to favorites', () => toggleFav(item))]));
  });
}
function syncRoomName() {
  const room = $('#room-name'), title = $('#room-title'), name = shared.roomName || '';
  if (room && document.activeElement !== room) room.value = name;
  if (title) title.textContent = name;
}
function renderShared() {
  syncRoomName();
  renderRecent();
  const fl = $('#fav-list'); fl.replaceChildren();
  if (!shared.favorites.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'Tap ♡ on a song to save it for both of you.'; fl.append(p); }
  shared.favorites.forEach(f => fl.append(itemRow(f, [mini('✕', 'Remove from favorites', () => toggleFav(f))])));
  const pl = $('#playlist-list');
  const wasOpen = new Set([...pl.querySelectorAll('details[open]')].map(d => d.dataset.id)); // a refresh must not collapse what you are editing
  pl.replaceChildren();
  if (!shared.playlists.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'No playlists yet.'; pl.append(p); }
  shared.playlists.forEach(p => {
    const d = document.createElement('details'); d.dataset.id = p.id; d.open = wasOpen.has(p.id);
    const s = document.createElement('summary'); s.textContent = `${p.name} (${p.items.length})`; d.append(s);
    const bar = document.createElement('div'); bar.className = 'row-actions';
    bar.append(
      mini('▶ Play', 'Play playlist', () => playItems(p.items)),
      mini('🔀', 'Shuffle play', () => playItems(p.items, { shuffle: true })),
      mini('✎', 'Rename playlist', () => { const name = (prompt('Playlist name', p.name) || '').trim(); if (name && name !== p.name) socket.emit('playlist:rename', { id: p.id, name }, r => { if (!r?.ok) notify(r?.error || 'Could not rename.'); }); }),
      mini('🗑', 'Delete playlist', () => { if (confirm(`Delete “${p.name}”?`)) socket.emit('playlist:delete', { id: p.id }); }));
    d.append(bar);
    p.items.forEach((i, n) => d.append(itemRow(i, [
      ...(n > 0 ? [mini('▲', 'Move up', () => socket.emit('playlist:move', { id: p.id, key: i.key, direction: -1 }))] : []),
      ...(n < p.items.length - 1 ? [mini('▼', 'Move down', () => socket.emit('playlist:move', { id: p.id, key: i.key, direction: 1 }))] : []),
      mini('✕', 'Remove from playlist', () => socket.emit('playlist:remove', { id: p.id, key: i.key }))])));
    pl.append(d);
  });
}
function renderSuggestBanner() {
  const b = $('#suggest-banner'); b.replaceChildren();
  if (!suggestion) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const { item, from } = suggestion;
  const msg = document.createElement('p'); msg.textContent = `${from} shares: ${item.title}${item.artist ? ' · ' + item.artist : ''}`;
  const row = document.createElement('div'); row.className = 'row-actions';
  row.append(mini(findInLibrary(item) || item.provider ? '🎧 Listen together' : '🎧 Add audio & listen', 'Listen together', () => listenTogether(item)), mini('♥ Favorite', 'Add to favorites', () => toggleFav(item)));
  const links = item.link ? [['Open link', item.link]] : searchLinks(item);
  links.forEach(([label, href]) => { const l = document.createElement('a'); l.href = href; l.target = '_blank'; l.rel = 'noopener noreferrer'; l.textContent = label; l.className = 'mini'; row.append(l); });
  row.append(mini('Dismiss', 'Dismiss', () => { suggestion = null; renderSuggestBanner(); }));
  b.append(msg, row);
}
$('#btn-new-playlist').onclick = newPlaylist;
$('#playlist-picker-close').onclick = closePlaylistPicker;
$('#playlist-picker').addEventListener('click', e => { if (e.target.id === 'playlist-picker') closePlaylistPicker(); });
$('#playlist-picker-create').onclick = newPlaylist;
$('#tap-play').onclick = () => { playRetries = 0; player.play(); $('#tap-play').classList.add('hidden'); };
$('#btn-suggest').onclick = () => {
  const title = $('#sug-title').value.trim(); if (!title) return notify('Enter the song title.');
  inviteToListen({ title, artist: $('#sug-artist').value.trim(), link: $('#sug-link').value.trim() });
  ['#sug-title', '#sug-artist', '#sug-link'].forEach(s => { $(s).value = ''; });
};

$('#btn-clear-recent').onclick = () => { if (recent.length && confirm('Clear your recently played list?')) socket.emit('recent:clear', {}); };
(async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem('syncpair-account') || 'null');
    if (saved?.token) {
      Object.assign(me, saved); $('#my-code').textContent = me.code;
      $('#create-box').classList.add('hidden'); $('#pair-box').classList.remove('hidden'); connectMine(me.token);
    }
  } catch { localStorage.removeItem('syncpair-account'); }
  try { await refreshLibrary(); } catch (error) { $('#upload-status').textContent = error.message; }
})();

// Personal theme controls: saved locally per device/browser.
(function initPersonalTheme(){
 const themes={
  rose:{accent:'#e6a5c4',accent2:'#b88ad4',bg:'#160f1c'},
  lavender:{accent:'#c5b5f3',accent2:'#8f79cb',bg:'#171322'},
  peach:{accent:'#ffc2a7',accent2:'#e89bba',bg:'#1b1316'},
  blue:{accent:'#9ec8e7',accent2:'#7e91c9',bg:'#101622'},
  green:{accent:'#a5d0bd',accent2:'#7caa9c',bg:'#121a18'}
 };
 const root=document.documentElement;
 function apply(t){
  for(const [k,v] of Object.entries(t))root.style.setProperty('--'+k,v);
  const a=document.querySelector('#theme-accent'),b=document.querySelector('#theme-accent2'),c=document.querySelector('#theme-bg');
  if(a)a.value=t.accent;if(b)b.value=t.accent2;if(c)c.value=t.bg;
 }
 function save(t){localStorage.setItem('syncpair-theme',JSON.stringify(t));apply(t)}
 try{const saved=JSON.parse(localStorage.getItem('syncpair-theme')||'null');if(saved)apply(saved)}catch{}
 const preset=document.querySelector('#theme-presets');
 preset?.addEventListener('click',e=>{
  const btn=e.target.closest('[data-theme]');if(!btn)return;
  preset.querySelectorAll('.theme-chip').forEach(x=>x.classList.toggle('active',x===btn));
  save(themes[btn.dataset.theme]);
 });
 ['theme-accent','theme-accent2','theme-bg'].forEach(id=>document.querySelector('#'+id)?.addEventListener('input',()=>{
  const t={accent:document.querySelector('#theme-accent').value,accent2:document.querySelector('#theme-accent2').value,bg:document.querySelector('#theme-bg').value};save(t);
  preset?.querySelectorAll('.theme-chip').forEach(x=>x.classList.remove('active'));
 }));
 document.querySelector('#theme-reset')?.addEventListener('click',()=>{save(themes.rose);preset?.querySelectorAll('.theme-chip').forEach(x=>x.classList.toggle('active',x.dataset.theme==='rose'));});
 const room=document.querySelector('#room-name'); let roomTimer=null;
 if(room)room.addEventListener('input',()=>{shared.roomName=room.value.trim();syncRoomName();clearTimeout(roomTimer);roomTimer=setTimeout(()=>socket?.emit('room:set',{name:room.value},r=>{if(r&&!r.ok)notify(r.error||'Could not save the room name.');}),500);});
})();


// Extra playback tools: library search/sort, shuffle, repeat, volume, sleep timer and keyboard shortcuts.
(function initPlaybackTools(){
  const search = $('#library-search'), sort = $('#library-sort');
  search?.addEventListener('input', renderLibrary);
  sort?.addEventListener('change', renderLibrary);
  const shuffle = $('#shuffle-toggle'), repeat = $('#repeat-toggle'), volume = $('#volume-control');
  shuffleOn = localStorage.getItem('syncpair-shuffle') === '1';
  repeatMode = localStorage.getItem('syncpair-repeat') || 'off';
  function paintModes(){
    shuffle?.classList.toggle('active', shuffleOn); shuffle?.setAttribute('aria-pressed', String(shuffleOn));
    repeat?.classList.toggle('active', repeatMode !== 'off'); repeat?.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    if(shuffle) shuffle.textContent = shuffleOn ? '⤨ Shuffle: On' : '⤨ Shuffle';
    if(repeat) repeat.textContent = repeatMode === 'one' ? '↻ Repeat: One' : repeatMode === 'all' ? '↻ Repeat: All' : '↻ Repeat: Off';
  }
  shuffle?.addEventListener('click',()=>{shuffleOn=!shuffleOn;localStorage.setItem('syncpair-shuffle',shuffleOn?'1':'0');paintModes();});
  repeat?.addEventListener('click',()=>{repeatMode = repeatMode==='off'?'all':repeatMode==='all'?'one':'off';localStorage.setItem('syncpair-repeat',repeatMode);paintModes();});
  paintModes();
  if(volume){volume.value=localStorage.getItem('syncpair-volume')||'85';audio.volume=Number(volume.value)/100;volume.addEventListener('input',()=>{audio.volume=Number(volume.value)/100;localStorage.setItem('syncpair-volume',volume.value);});}
  const timer=$('#sleep-timer'), status=$('#sleep-status');
  function clearSleep(){sleepDeadline=0;sleepAtTrackEnd=false;if(sleepInterval){clearInterval(sleepInterval);sleepInterval=null;}if(timer)timer.value='0';if(status)status.textContent='';}
  window.stopForSleep=function(){player.pause();broadcast('pause');clearSleep();if(status)status.textContent='Playback paused for your sleep timer.';};
  timer?.addEventListener('change',()=>{
    clearSleep();
    if(timer.value==='end'){sleepAtTrackEnd=true;if(status)status.textContent='Will pause at the end of this track.';return;}
    const mins=Number(timer.value);if(!mins)return;
    sleepDeadline=Date.now()+mins*60000;
    status.textContent=`Pauses in ${mins} min`;
    sleepInterval=setInterval(()=>{const left=sleepDeadline-Date.now();if(left<=0){stopForSleep();return;}status.textContent=`Pauses in ${Math.ceil(left/60000)} min`;},15000);
  });
  document.addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea,select,[contenteditable="true"]') || e.altKey || e.ctrlKey || e.metaKey) return;
    if(e.code==='Space'){e.preventDefault();togglePlay();}
    else if(e.key==='ArrowLeft'&&player.track){player.seek(Math.max(0,player.pos()-5000));broadcast('seek');}
    else if(e.key==='ArrowRight'&&player.track){player.seek(Math.min(player.duration()||Infinity,player.pos()+5000));broadcast('seek');}
    else if(e.key.toLowerCase()==='m' && volume){audio.muted=!audio.muted;volume.value=audio.muted?'0':(localStorage.getItem('syncpair-volume')||'85');}
  });
})();


// ---- Home navigation: bottom tabs + persistent mini-player (the player used to sit at the bottom of one long scroll) ----
(function initHomeTabs() {
  const home = $('#screen-home'); if (!home) return;
  const top = el => el?.closest('#screen-home > *');
  const nowCard = $('.now-card'), partnerCard = $('#partner-card');
  if (nowCard && partnerCard) partnerCard.after(nowCard); // the player is the hero: right under your partner
  const groups = {
    home: [partnerCard, nowCard, top($('#recent-list'))],
    library: [$('.library-card'), top($('#sug-title'))],
    lists: [top($('#fav-list')), top($('#playlist-list'))],
    style: [$('.theme-panel')],
  };
  Object.entries(groups).forEach(([tab, els]) => els.forEach(el => { if (el) el.dataset.tab = tab; }));
  const tabs = [['home', 'home', 'Home'], ['library', 'music', 'Library'], ['lists', 'heart', 'Playlists'], ['style', 'spark', 'Style']];
  const nav = document.createElement('nav'); nav.id = 'tabbar'; nav.className = 'hidden'; nav.setAttribute('aria-label', 'Sections');
  tabs.forEach(([id, iconName, label]) => {
    const b = document.createElement('button'); b.dataset.go = id; b.innerHTML = '<span class="ti"></span><span class="tl"></span>';
    b.children[0].innerHTML = icon(iconName); b.children[1].textContent = label; b.onclick = () => setTab(id); nav.append(b);
  });
  const mp = document.createElement('div'); mp.id = 'mini-player'; mp.className = 'hidden';
  mp.innerHTML = '<div class="art"></div><div class="mp-info"><b></b><span class="dim small"></span></div><button class="mp-play" aria-label="Play or pause"></button><button class="mp-next" aria-label="Next track">⏭</button><div class="mp-prog"><i></i></div>';
  mp.querySelector('.mp-next').innerHTML = icon('next');
  document.body.append(mp, nav);
  let tab = 'home', lastArt = '';
  function setTab(id) {
    if (!groups[id]) id = 'home';
    tab = id; home.dataset.tab = id;
    Object.entries(groups).forEach(([name, els]) => els.forEach(el => { if (el) el.classList.toggle('tab-off', name !== id); }));
    nav.querySelectorAll('button').forEach(b => b.toggleAttribute('aria-current', b.dataset.go === id));
    try { localStorage.setItem('syncpair-tab', id); } catch {}
    window.scrollTo({ top: 0 });
  }
  mp.querySelector('.mp-info').onclick = mp.querySelector('.art').onclick = () => setTab('home');
  mp.querySelector('.mp-play').onclick = () => togglePlay();
  mp.querySelector('.mp-next').onclick = () => skip(1);
  // A link player (YouTube/Spotify...) must be visible to play reliably: jump back to Home when one loads.
  const wrap = $('#embed-wrap');
  if (wrap) new MutationObserver(() => { if (!wrap.classList.contains('hidden') && tab !== 'home') setTab('home'); }).observe(wrap, { attributes: true, attributeFilter: ['class'] });
  setInterval(() => {
    const onHome = !home.classList.contains('hidden');
    nav.classList.toggle('hidden', !onHome);
    const t = player.track, showMini = onHome && !!t && tab !== 'home';
    mp.classList.toggle('hidden', !showMini);
    if (!showMini) return;
    const art = artStyle(t); if (art !== lastArt) { lastArt = art; mp.querySelector('.art').style.cssText = art; }
    mp.querySelector('b').textContent = t.title; mp.querySelector('.mp-info span').textContent = t.artist || '';
    mp.querySelector('.mp-play').innerHTML = icon(player.playing ? 'pause' : 'play');
    const d = player.duration(); mp.querySelector('.mp-prog i').style.width = (d > 0 ? Math.min(100, player.pos() / d * 100) : 0) + '%';
  }, 500);
  let saved = 'home'; try { saved = localStorage.getItem('syncpair-tab') || 'home'; } catch {}
  setTab(saved);
})();


// ---- Fine-tune: personal look (font, corners, text size, alignment, background, density, motion), saved per device ----
(function initFineTune() {
  const panel = $('.theme-panel'); if (!panel) return;
  const DEFAULTS = { align: 'left', font: 'rounded', radius: 22, scale: 100, bg: 'dots', density: 'cozy', motion: 'on' };
  let look = { ...DEFAULTS };
  try { look = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('syncpair-look') || '{}') }; } catch {}
  const root = document.documentElement;
  function apply() {
    root.dataset.align = look.align; root.dataset.font = look.font; root.dataset.bg = look.bg;
    root.dataset.density = look.density; root.dataset.motion = look.motion;
    root.style.setProperty('--radius', look.radius + 'px'); root.style.setProperty('--scale', String(look.scale / 100));
    try { localStorage.setItem('syncpair-look', JSON.stringify(look)); } catch {}
  }
  const select = (key, label, options) => ({ key, label, options });
  const controls = [
    select('align', 'Alignment', [['left', 'Left'], ['center', 'Centered']]),
    select('font', 'Font', [['rounded', 'Soft rounded'], ['classic', 'Clean modern'], ['serif', 'Elegant serif'], ['mono', 'Typewriter']]),
    select('bg', 'Background', [['dots', 'Dotted'], ['glow', 'Glow'], ['plain', 'Plain']]),
    select('density', 'Spacing', [['cozy', 'Cozy'], ['compact', 'Compact']]),
    select('motion', 'Animations', [['on', 'On'], ['off', 'Off']]),
  ];
  const box = document.createElement('details'); box.innerHTML = '<summary>Fine-tune the look</summary><div class="finetune"></div>';
  const body = box.querySelector('.finetune');
  const selects = {};
  controls.forEach(c => {
    const l = document.createElement('label'), s = document.createElement('select'); l.append(c.label + ' ');
    c.options.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); });
    s.onchange = () => { look[c.key] = s.value; apply(); }; selects[c.key] = s; l.append(s); body.append(l);
  });
  const sliders = {};
  [['radius', 'Corner roundness', 6, 36], ['scale', 'Text & size', 90, 120]].forEach(([key, label, min, max]) => {
    const l = document.createElement('label'), r = document.createElement('input'); l.append(label + ' ');
    Object.assign(r, { type: 'range', min, max, step: 1 }); r.oninput = () => { look[key] = Number(r.value); apply(); }; sliders[key] = r; l.append(r); body.append(l);
  });
  const reset = document.createElement('button'); reset.className = 'mini'; reset.textContent = 'Reset look';
  reset.onclick = () => { look = { ...DEFAULTS }; sync(); apply(); }; body.append(reset);
  function sync() { Object.entries(selects).forEach(([k, s]) => { s.value = look[k]; }); Object.entries(sliders).forEach(([k, r]) => { r.value = look[k]; }); }
  const roomLabel = panel.querySelector('label[for="room-name"]');
  panel.insertBefore(box, roomLabel || null);
  sync(); apply();
  // Show the room name as a title on the home screen.
  const header = $('#screen-home > header'), room = $('#room-name');
  if (header && room) {
    const title = document.createElement('p'); title.id = 'room-title'; header.after(title);
    const paint = () => { title.textContent = room.value.trim(); }; room.addEventListener('input', paint); paint();
  }
})();

// Static transport icons (prev/next/play) — replaces emoji glyphs with consistent SVGs.
document.querySelectorAll('[data-icon]').forEach(b => { b.innerHTML = icon(b.dataset.icon); });
['#me-play', '#s-play'].forEach(id => { $(id).innerHTML = icon('play'); });
