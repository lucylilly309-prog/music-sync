# SyncPair Universal — mobile-first music synchronization

> **What is in this archive:** the Node.js + Socket.IO server and the mobile-first **web client** (`index.html`, `app.js`, `style.css`, `embed.html`). The Flutter app described under *Architecture* and *Mobile setup* (`mobile/`) is **not included** in this archive; those sections are kept as the design reference for it. Everything below marked "web" works today by opening the server URL on a phone.

SyncPair Universal is a native Android/iOS app plus a small Node.js + Socket.IO coordination server. It does not require Spotify or another subscription integration. The reliable shared mode uses SyncPair's own player and a shared library. The Android build also contains an opt-in Android MediaSession adapter for compatible external players.

## Product contract: what is and is not universal

There is no public cross-platform API that lets one app fully control every other music app. In particular, iOS does not let third-party apps arbitrarily pause, seek, or change tracks in other apps. Android exposes compatible media sessions after the user grants notification-listener access, but some apps restrict or omit commands.

| Source | Android | iPhone |
|---|---|---|
| Audio uploaded to SyncPair | Full play/pause/seek/skip synchronization | Full play/pause/seek/skip synchronization |
| Same audio file stored locally on both phones | Full in-app playback; each device can use its local copy | Full in-app playback; each device can use its local copy |
| Compatible external Android media session | Best-effort play/pause/next/previous/seek controls | Cannot control the Android app from iOS |
| Arbitrary streaming app/site | Not guaranteed | Not supported as a generic external control target |

For the full cross-platform experience, both partners should play the same track through SyncPair. Files uploaded to the shared library are streamed from the server; users can also save them for offline playback. The app also imports local audio files without uploading them. Each imported file is identified by a SHA-256 hash, so both partners can import the exact same file and SyncPair can match it. Cached or imported audio can play without a network connection; live synchronization still requires both devices to be online so they can exchange timestamped controls.

SyncPair does not bypass DRM, extract audio from other apps, or provide music licensing. Only share audio you have permission to use.

## Architecture

```text
             Partner A (Android or iOS)        Partner B (Android or iOS)
            ┌─────────────────────────┐       ┌─────────────────────────┐
            │ Flutter UI              │       │ Flutter UI              │
            │ Pairing / library        │       │ Pairing / library        │
            │ just_audio player        │       │ just_audio player        │
            │ Android MediaSession     │       │ Android MediaSession     │
            │ adapter (Android only)  │       │ adapter (Android only)  │
            └────────────┬────────────┘       └────────────┬────────────┘
                         │ HTTPS + Socket.IO               │
                         └──────────────┬──────────────────┘
                                ┌───────▼────────┐
                                │ Node / Express │
                                │ Socket.IO rooms│
                                │ Pairing + state│
                                │ Shared library │
                                └───────┬────────┘
                                        │
                                Persistent disk
                                /music + data.json
```

- **Flutter client:** one codebase for Android and iOS; `just_audio` handles the app-owned player and background playback notifications.
- **Platform adapter:** Kotlin `MediaSessionManager` controls compatible Android media sessions after explicit notification access. iOS intentionally uses SyncPair's own player; there is no generic external-player control API.
- **Synchronization server:** authenticates Socket.IO connections with per-account bearer tokens, pairs accounts, maintains session rooms, and relays timestamped commands. The session initiator is the sync clock leader and sends a 5-second `sync` heartbeat; the receiver estimates elapsed time from the server timestamp and corrects by seeking when drift exceeds 750 ms for uploaded audio or 2 s for embedded link players (at most once every 5 s). Audio is not relayed through Socket.IO.
- **Audio distribution:** uploaded files live on the server's persistent volume. Each phone streams them and can download them into app storage for offline playback.

## Sharing features

- **Share a song from any player:** Android share sheet (Spotify, YouTube, etc. → SyncPair), the "What I'm playing" button (reads the active Android media session), or the manual form (web / iPhone). Only title, artist and link are sent; the partner can favorite it or open a search/link. Audio from other apps is never extracted.
- **Invite to listen:** 📨 on a library song starts a synced session and the partner sees "invited you to listen to …".
- **Favorites together** and **shared playlists** are stored per couple on the server (`data.json`, `pairs`) and update live for both phones.

## Personalizing

Style tab: theme presets and custom colors, plus *Fine-tune the look* (alignment, font, corner roundness, text size, background, spacing, animations) and a room name shown as the home title. Everything is centered by default; choose *Left* alignment to switch back. All choices are saved per device.

## Navigation

The home screen has a bottom tab bar (Home · Library · Playlists · Style) and a mini-player that keeps the current song controllable from any tab. Link players (YouTube / Spotify / SoundCloud) must stay visible to play, so loading one jumps back to Home. The last tab is remembered per device.

## Up next (shared queue)

Tap **＋ Next** on any library song, favorite, playlist entry or link (or *Up next* in a library row's ⋯ menu) to add it to the couple's shared queue on Home. Either partner can reorder or remove entries, and it updates live on both phones.

- In a listening session, **Next** (and the end of a song) plays the head of Up next first; the queue entry is removed on the server in one step (`queue:shift`), so the two phones never consume the same song twice. When Up next is empty, playback resumes from the library or playlist where it left off.
- Outside a session, **▶ Play together** takes the head, opens a session with it, and the rest plays as songs end.
- Only uploaded songs and links can be queued (title-only suggestions cannot be played together). Limit: 100 entries. Deleting or renaming a library song updates the queue too.

## Staying signed in

- The account token is kept in `localStorage` **and** in a one-year `HttpOnly` cookie (`sp_session`). If the browser clears one, `GET /api/session` brings the account back from the other. The app also asks the browser for persistent storage.
- If the **server** forgets the account (its data was reset), the app no longer logs you out: it calls `POST /api/restore` with the id and token the phone still holds, and the server re-creates the account. The couple is re-linked automatically once **both** phones have restored (each claims the other, each proves itself with its own token).
- A restore cannot bring back what only lived on the server (uploaded songs, shared playlists, notes). Check `GET /health`: `persistentStorage: false` means the host is wiping data. Fix it with a persistent disk and `DATA_DIR` (see `DEPLOY-RENDER.md`); the server also logs a warning at startup when it detects Render without `DATA_DIR`.
- Only a refused restore (the account id is taken by a different token) sends you back to sign-up.

## Long-distance extras (the "Us" card on Home)

- **Partner's local time:** each phone reports its time zone; the card shows their clock, the hour difference, and 🌙 "probably asleep" between 23:00 and 06:00 their time.
- **Status:** an emoji + up to 60 characters ("on the bus", "heading to bed"), shown on the partner's card live.
- **Countdown to the next visit** and **days together:** set once, shared and editable by both. The countdown shows "N days until …", "Today", or prompts for the next date once it has passed.
- **One-tap pings:** 💗 Thinking of you, 🥺 Miss you, ☀️ Good morning, 🌙 Good night. The partner gets a toast and a short vibration if the app is open; the last pings stay visible as moments so nothing is lost while they are away. (Delivery while the app is closed needs push notifications, which are not built yet.)
- Server events: `profile:set`, `partner:profile`, `us:set`, `ping:send`, `ping:received`; countdown, since-date and the last 10 pings travel in the shared payload.

## Listen along, sync tuning, reconnects

- **Listen along from here:** when your partner is playing a song you can also play (a shared-library track or a link) and you are not in a session, their card on Home shows a button. It sends them an invite and starts the song at their current position.
- **Sync tuning (Style tab):** Bluetooth headphones add 100–300 ms of delay. *Headphone delay* makes this phone play slightly ahead of the partner's clock (applies to controls and drift correction that come from the partner, never to your own). Saved per device.
- **Reconnects:** the app shows "Connection lost. Reconnecting…" and "Back online." instead of failing silently, and reloads the library on recovery. A phone that rejoins a live session is re-synced by the partner's phone automatically (`session:resume` + `session:peer-joined`).

## Offline shell (service worker)

`sw.js` caches the app shell (page, script, styles, icons, Socket.IO client) and serves the last good copy if the network is down, so the app opens instantly and survives a flaky connection. It never touches `/api`, `/music` or the Socket.IO transport: live sync, uploads and audio streaming still need the server. Bump the `?v=` on `style.css` / `app.js` in `index.html` and `VERSION` in `sw.js` together on each release.

## Install on your phone and lock-screen controls (web client)

- **Add to Home Screen** (iOS Safari: Share → Add to Home Screen; Android Chrome: menu → Install app). The server publishes a web manifest and icons, so SyncPair opens full-screen like an app.
- Playback uses the browser **Media Session API**: song title, artist and play / pause / previous / next / seek controls appear on the lock screen, Bluetooth headphones and car displays. These controls go through the same code as the on-screen buttons, so they stay synchronized with your partner.
- Messages (errors, "could not send", etc.) appear as small toasts instead of blocking dialogs, so they never interrupt playback.
- If the server forgets your account (for example its data disk was reset), the app now says so and returns to account creation instead of sitting silently on the pairing screen.
- A note you are typing on your partner's profile is no longer wiped when their playback status updates.

## Reliability notes

- `data.json` is written atomically (temp file + rename) with a rolling `data.json.bak`. If the main file is ever unreadable the server restores from the backup and sets the bad file aside as `data.json.corrupt-<timestamp>` instead of starting empty. Pending writes are flushed on `SIGTERM`, which Render sends on every deploy.
- During a session only the session leader auto-advances at the end of a song and sends a 5-second `sync` heartbeat; the follower steps in only if nothing arrives. This keeps shuffle from desynchronizing the two phones.
- Playlists can be renamed, reordered, shuffled and can mix uploaded songs with YouTube / Spotify / SoundCloud / direct-audio links. Deleting a song removes it from favorites, playlists and history.
- `npm test` runs two suites: `test/smoke.js` starts the server on a temporary data directory and drives it with two simulated phones (pairing, library, playlists, sessions, restart + corrupted-file recovery, static files, JSON errors); `test/client.js` loads the web client in jsdom and checks the note-draft, stale-account and toast behaviour.
- Rate-limiter state is pruned periodically, and body-parser errors (oversized or malformed requests) are returned as JSON.

## Server setup

Requirements: Node.js 18+.

```bash
npm install
npm start
```

Server listens on `http://localhost:3000`. Check `http://localhost:3000/health`.

For two people in different locations, deploy the Node server to a host with HTTPS, WebSocket support, and persistent disk storage. Set `DATA_DIR` to the mounted disk path. Both phones must enter the exact same public URL in the app.

## Mobile setup

Requirements: Flutter 3.24+ and Android Studio (Android SDK); Xcode on macOS for iOS builds. Windows can build Android, but iOS builds require macOS/Xcode.

1. Open a terminal in `mobile/`.
2. Generate the platform scaffolding once:

   ```bash
   flutter create --project-name syncpair --platforms=android,ios .
   ```

3. Run `flutter pub get`.
4. Merge `android/AndroidManifest.fragment.xml` into `android/app/src/main/AndroidManifest.xml` inside the `<manifest>` and `<application>` elements as indicated in the fragment.
5. Copy `android/app/src/main/kotlin/com/example/syncpair/MainActivity.kt` and `SyncPairNotificationListener.kt` into the generated Kotlin package path. Ensure the `namespace` and `applicationId` in `android/app/build.gradle` are `com.example.syncpair` (or update the Kotlin package path to match).
6. For iOS background audio, merge `ios/Info.plist.fragment.xml` into `ios/Runner/Info.plist`. The app-owned player uses the iOS audio session; external app control is intentionally unavailable.
7. Start the app:

   ```bash
   flutter run
   ```

8. Enter the deployed SyncPair server URL, create an account on each phone, exchange pairing codes, and start a listening session.

To build Android APK:

```bash
flutter build apk --release
```

To build iOS, run on macOS with Xcode configured:

```bash
flutter build ios --release
```

## Android external-player setup

1. Start music in a compatible player (for example, one that publishes an Android media session).
2. In SyncPair, tap **Connect Android media player**.
3. Enable SyncPair under Android's Notification access settings.
4. Return to SyncPair. External controls target the active media session returned by Android. The exact command set depends on the external app.

Granting notification access is sensitive. Android shows a system settings screen; the user must enable it manually. SyncPair does not read message contents or notification text; the integration uses the media-session API.

## Current implementation scope / next engineering steps

This is an implementation scaffold and functional MVP, not a store-ready release. Before production, complete:

- User authentication with passwordless email / passkeys, token rotation, logout, and account recovery.
- Library and audio files are scoped to a pair (uploader + partner); `/music/*` requires the account token. Each pair has a 250 MB quota, and songs can be renamed (either partner) or deleted (uploader only) via `PATCH`/`DELETE /api/library/:id`.
- Database-backed users/tracks/sessions, durable session recovery, upload quotas, file validation, rate limits, malware scanning, backups, and abuse reporting.
- Audio fingerprinting and an explicit same-track confirmation workflow before attempting to synchronize independent external players.
- Android active-session selection (rather than first active session), external metadata/state observation, and per-player capability tests.
- iOS integration testing for background playback, interruptions, AirPlay, and Bluetooth routes.
- Drift measurement tests across mobile networks; timestamped control relay is not a guarantee of sample-accurate synchronization.

The current Android adapter can send basic transport commands to the first active media session. It is not a universal controller for every Android app. Cross-platform full sync is provided by the in-app player.

## Listening from a shared link

Paste or share a link and tap **Listen together**:

| Link | What happens |
|---|---|
| YouTube / YouTube Music / Shorts | Official embedded player on both phones, fully synced (play, pause, seek, drift correction). |
| Spotify (track, episode, album, playlist) | Spotify's embedded player, synced. Each person needs to be logged in to Spotify in the embedded player for full tracks (otherwise 30 s previews), and must tap the player once to allow playback. |
| SoundCloud | SoundCloud widget, synced. |
| Direct audio URL (`https://…/song.mp3`) | Played natively, synced. |
| Apple Music, Deezer, Tidal, Amazon Music, Qobuz, Anghami, Bandcamp… | These apps expose no playback API, so SyncPair shows a shared clock and an **Open in app** button: both press play in their own app when the timer starts. Play/pause/seek here cue your partner. |

Nothing is downloaded or extracted from any service. Videos whose owner disallows embedding will not play.
Both clients load `/embed.html` (YouTube/Spotify/SoundCloud bridge); Flutter uses a `webview_flutter` WebView for it.

## Testing alone with two devices

- Use **two different SyncPair accounts** (one per device/browser). Two tabs of the same browser share one account.
- **Spotify** only streams to one device per Spotify account: if both phones use the same Spotify login, starting playback on one stops the other. Log in with two accounts (a free account gives 30 s previews).
- Apple Music / Deezer / Tidal behave the same way (one active stream per account).


## Security and synchronization patch (Nov 2026)

- Account tokens are stored as SHA-256 hashes in the server data file (legacy token fields are migrated at startup).
- Socket event throttles added for pairing, session controls, chat, reactions, favorites, playlists, and library activity.
- Audio upload capped at 50 MB per file and 250 MB per couple, with an upload rate limit.
- Pair codes are rotated for both users after a successful pairing.
- Basic server startup and `/health` smoke test passed.

**Important:** the account tokens in the original archive were exposed. Hashing protects storage going forward, but it does not revoke a token already copied from the old archive. Treat the old archive as compromised and use a fresh account pair if the old ZIP has been shared.


## Partner profile notes

Paired users can leave short (up to 280-character) notes on the partner profile wall. Notes sync in real time through Socket.IO, persist in the pair's shared data, and remain separate from shared listening-session chat. Authors can remove their own notes.
