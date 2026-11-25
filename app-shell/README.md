# SyncPair APK / IPA
1. Push this repo to GitHub. Settings → Secrets and variables → Actions → Variables → add SERVER_URL (your Render URL, https).
2. Actions → "Build APK and IPA" → Run workflow.
3. Download SyncPair-apk (app-debug.apk, install directly) and SyncPair-ipa (unsigned; sideload with Sideloadly/AltStore, or sign with your Apple account).

## Home-screen widget and push (Android)

`native/android/` holds the widget (`SyncPairWidgetProvider`), the Capacitor plugin that feeds it (`SyncPairWidgetPlugin`) and its resources. `scripts/apply-native.js` copies them into the generated `android/` project, registers the receiver in `AndroidManifest.xml` and, when `GOOGLE_SERVICES_JSON` is set, writes `google-services.json` for push notifications. Run it after `npx cap add android` (the GitHub workflow already does).

This code is syntax-checked and its resources validated, but it needs an Android SDK to compile: build the APK and try the widget on a real phone before you rely on it.

