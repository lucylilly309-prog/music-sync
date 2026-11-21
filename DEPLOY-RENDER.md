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

Do not use ephemeral storage for uploaded audio or user data. The server MVP still needs production hardening: authenticated library access, quotas, durable database, rate limits, and backups.

The server keeps `data.json.bak` next to `data.json` on the disk and flushes pending writes when Render stops the service. Never commit `data.json`, `data.json.bak` or `music/`: they contain account token hashes and private audio.
