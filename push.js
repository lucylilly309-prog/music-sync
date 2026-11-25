'use strict';
// Push notifications for people who do not have the app open: Web Push (browsers, installed PWA) and
// Firebase Cloud Messaging (the Android app). Someone who is online (app open) is never pushed: they already
// get the live toast. Subscriptions live on the user record (users spread into data.json).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const b64u = buf => Buffer.from(buf).toString('base64url');

module.exports = function createPush({ users, saveData, dataDir, env = process.env }) {
  const MAX_PER_KIND = 5;
  // Browsers only ever hand out endpoints on these push services; refusing anything else stops the server being
  // used to send requests to arbitrary hosts. PUSH_ALLOWED_HOSTS adds exact hostnames (used by the tests).
  const allowedHosts = ['.googleapis.com', '.mozilla.com', '.windows.com', '.apple.com', ...String(env.PUSH_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)];
  const hostOk = host => allowedHosts.some(h => (h.startsWith('.') ? host.endsWith(h) : host === h));

  // ---- Web Push (VAPID keys: from env, else generated once and kept next to data.json) ----
  let wp = null, vapid = null;
  const ready = (async () => {
    try {
      wp = await import('web-push'); // ESM-only package, hence the dynamic import
      if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
      else {
        const file = path.join(dataDir, 'vapid.json');
        try { vapid = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        if (!vapid?.publicKey || !vapid?.privateKey) {
          vapid = wp.generateVAPIDKeys();
          fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 });
        }
      }
      wp.setVapidDetails(env.VAPID_SUBJECT || 'mailto:syncpair@example.com', vapid.publicKey, vapid.privateKey);
    } catch (e) { console.error('Web Push is unavailable:', e.message); wp = null; }
  })();

  // ---- FCM HTTP v1 (service account JSON in FIREBASE_SERVICE_ACCOUNT, raw or base64) ----
  const sa = (() => {
    const raw = String(env.FIREBASE_SERVICE_ACCOUNT || '').trim(); if (!raw) return null;
    try {
      const j = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      return j.client_email && j.private_key && j.project_id ? j : null;
    } catch { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON; Android notifications are off.'); return null; }
  })();
  let fcmAuth = { token: '', exp: 0 }, fcmAuthPending = null;
  function fcmAccessToken() { // one token request at a time, however many sends are waiting for it
    if (fcmAuth.token && Date.now() < fcmAuth.exp - 60_000) return Promise.resolve(fcmAuth.token);
    return (fcmAuthPending ||= fetchFcmToken().finally(() => { fcmAuthPending = null; }));
  }
  async function fetchFcmToken() {
    const uri = sa.token_uri || 'https://oauth2.googleapis.com/token', iat = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: uri, iat, exp: iat + 3600 }));
    const sig = b64u(crypto.sign('RSA-SHA256', Buffer.from(head + '.' + claims), sa.private_key));
    const res = await fetch(uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error('FCM authentication failed');
    fcmAuth = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return fcmAuth.token;
  }

  // ---- Subscriptions ----
  function addWebSub(user, sub) {
    let url; try { url = new URL(String(sub?.endpoint || '')); } catch { return { ok: false, error: 'Invalid subscription.' }; }
    const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
    if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100 || String(sub.endpoint).length > 2000) return { ok: false, error: 'Invalid subscription.' };
    if (url.protocol !== 'https:' || !hostOk(url.hostname)) return { ok: false, error: 'Unsupported push service.' };
    user.pushSubs = [...(user.pushSubs || []).filter(s => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh, auth }, at: Date.now() }].slice(-MAX_PER_KIND);
    saveData(); return { ok: true };
  }
  function addFcmToken(user, token) {
    token = String(token || '');
    if (!token || token.length > 4096) return { ok: false, error: 'Invalid token.' };
    user.fcmTokens = [...(user.fcmTokens || []).filter(t => t !== token), token].slice(-MAX_PER_KIND);
    saveData(); return { ok: true };
  }
  function remove(user, { endpoint, all } = {}) {
    if (all) { user.pushSubs = []; user.fcmTokens = []; }
    else if (endpoint) user.pushSubs = (user.pushSubs || []).filter(s => s.endpoint !== endpoint);
    saveData();
  }

  // ---- Sending ----
  async function sendWeb(user, sub, payload) {
    try { await wp.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, timeout: 8000 }); }
    catch (e) {
      // 404/410: gone. 401/403: the VAPID key changed since they subscribed. Either way it can never work again.
      if ([401, 403, 404, 410].includes(e.statusCode)) { user.pushSubs = (user.pushSubs || []).filter(s => s.endpoint !== sub.endpoint); saveData(); }
    }
  }
  async function sendFcm(user, token, p) {
    try {
      const base = env.FCM_SEND_BASE || 'https://fcm.googleapis.com';
      const res = await fetch(`${base}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + await fcmAccessToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title: p.title, body: p.body }, data: { url: p.url, tag: p.tag }, android: { priority: 'HIGH', notification: { tag: p.tag } } } })
      });
      if (res.ok) return;
      const j = await res.json().catch(() => ({})), msg = String(j.error?.message || '');
      if (res.status === 404 || (res.status === 400 && /registration token/i.test(msg))) { user.fcmTokens = (user.fcmTokens || []).filter(t => t !== token); saveData(); }
    } catch {}
  }
  // Never throws. Nothing is sent to someone who has the app open.
  async function notify(user, { title, body, tag = 'syncpair', url = '/' }) {
    if (!user || user.online) return;
    await ready;
    const p = { title: String(title).slice(0, 100), body: String(body || '').slice(0, 200), tag, url };
    const jobs = [];
    if (wp) for (const s of user.pushSubs || []) jobs.push(sendWeb(user, s, p));
    if (sa) for (const t of user.fcmTokens || []) jobs.push(sendFcm(user, t, p));
    await Promise.allSettled(jobs);
  }

  return { ready, notify, addWebSub, addFcmToken, remove, publicKey: () => vapid?.publicKey || '', fcmEnabled: !!sa };
};
