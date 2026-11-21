# SyncPair Universal — mobile-first music synchronization

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
- **Synchronization server:** authenticates Socket.IO connections with per-account bearer tokens, pairs accounts, maintains session rooms, and relays timestamped commands. The session initiator is the sync clock leader and sends a three-second correction tick; the receiver estimates elapsed time from the server timestamp and seeks only when drift exceeds 250 ms. Audio is not relayed through Socket.IO.
- **Audio distribution:** uploaded files live on the server's persistent volume. Each phone streams them and can download them into app storage for offline playback.

## Sharing features

- **Share a song from any player:** Android share sheet (Spotify, YouTube, etc. → SyncPair), the "What I'm playing" button (reads the active Android media session), or the manual form (web / iPhone). Only title, artist and link are sent; the partner can favorite it or open a search/link. Audio from other apps is never extracted.
- **Invite to listen:** 📨 on a library song starts a synced session and the partner sees "invited you to listen to …".
- **Favorites together** and **shared playlists** are stored per couple on the server (`data.json`, `pairs`) and update live for both phones.

## Personalizing

Style tab: theme presets and custom colors, plus *Fine-tune the look* (alignment, font, corner roundness, text size, background, spacing, animations) and a room name shown as the home title. Everything is centered by default; choose *Left* alignment to switch back. All choices are saved per device.

## Navigation

The home screen has a bottom tab bar (Home · Library · Playlists · Style) and a mini-player that keeps the current song controllable from any tab. Link players (YouTube / Spotify / SoundCloud) must stay visible to play, so loading one jumps back to Home. The last tab is remembered per device.

## Reliability notes

- `data.json` is written atomically (temp file + rename) with a rolling `data.json.bak`. If the main file is ever unreadable the server restores from the backup and sets the bad file aside as `data.json.corrupt-<timestamp>` instead of starting empty. Pending writes are flushed on `SIGTERM`, which Render sends on every deploy.
- During a session only the session leader auto-advances at the end of a song and sends a 5-second `sync` heartbeat; the follower steps in only if nothing arrives. This keeps shuffle from desynchronizing the two phones.
- Playlists can be renamed, reordered, shuffled and can mix uploaded songs with YouTube / Spotify / SoundCloud / direct-audio links. Deleting a song removes it from favorites, playlists and history.
- `npm test` starts the server on a temporary data directory and runs an end-to-end smoke test with two simulated phones.

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
