# Deploy the SyncPair coordination server

1. Push the contents of this folder (except `node_modules`, `data.json`, and `music/`) to a private Git repository.
2. Create a Render Web Service from that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Health check path: `/health`
6. Attach a persistent disk, for example at `/var/data`.
7. Set environment variable `DATA_DIR=/var/data`.
8. Deploy and verify `https://YOUR-SERVICE.onrender.com/health` returns `{"ok":true,...}`.
9. Enter that HTTPS URL in SyncPair on both phones.

**If people keep getting signed out:** open `/health`. `"persistentStorage": false` means the server is running on Render without `DATA_DIR`, so every restart, idle spin-down and deploy wipes `data.json` and `music/`. Accounts and pairing now restore themselves automatically (see *Staying signed in* in the README), but songs, playlists and notes are lost each time until a disk is attached. A free Render instance cannot attach a disk; use a paid instance with a disk, or another host that offers a persistent volume.

Do not use ephemeral storage for uploaded audio or user data: without the persistent disk, every deploy erases all accounts and music (clients will then show "saved account was not found" and ask people to sign up again).

Already in place: token-authenticated library and audio access, per-file (50 MB) and per-couple (250 MB) limits, request rate limits and atomic data writes with a rolling backup. Still recommended before wider use: a real database, off-disk backups, audio file validation and abuse reporting.

The server keeps `data.json.bak` next to `data.json` on the disk and flushes pending writes when Render stops the service. Never commit `data.json`, `data.json.bak` or `music/`: they contain account token hashes and private audio.

## Notifications and the widget

Optional environment variables: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (keep Web Push subscriptions valid across restarts; generate with `npx web-push generate-vapid-keys`) and `FIREBASE_SERVICE_ACCOUNT` (Android push; see *Notifications* in the README). The Android widget needs no server setup: it uses `GET /api/widget`.
