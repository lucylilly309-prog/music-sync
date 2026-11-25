#!/usr/bin/env node
// Run right after `npx cap add android`. Adds the home-screen widget (+ the Capacitor plugin that feeds it) to the
// generated Android project and, when GOOGLE_SERVICES_JSON is set, the Firebase config that push notifications need.
// Safe to run more than once.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), android = path.join(root, 'android'), src = path.join(root, 'native', 'android');
if (!fs.existsSync(android)) { console.error('android/ not found. Run `npx cap add android` first.'); process.exit(1); }
const mainDir = path.join(android, 'app', 'src', 'main');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

for (const f of walk(path.join(src, 'java'))) copy(f, path.join(mainDir, 'java', 'com', 'syncpair', 'app', path.basename(f)));
for (const f of walk(path.join(src, 'res'))) copy(f, path.join(mainDir, 'res', path.relative(path.join(src, 'res'), f)));

const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('SyncPairWidgetProvider')) {
  if (!manifest.includes('</application>')) throw new Error('Unexpected AndroidManifest.xml: no </application>');
  manifest = manifest.replace('</application>', fs.readFileSync(path.join(src, 'manifest-receiver.xml'), 'utf8').replace(/\s+$/, '') + '\n    </application>');
}
if (!manifest.includes('POST_NOTIFICATIONS')) manifest = manifest.replace('</manifest>', '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>');
fs.writeFileSync(manifestPath, manifest);

const gs = process.env.GOOGLE_SERVICES_JSON;
if (gs && gs.trim()) {
  JSON.parse(gs); // fail the build early on a pasted-wrong secret
  fs.writeFileSync(path.join(android, 'app', 'google-services.json'), gs);
  console.log('Firebase config written: push notifications enabled.');
} else console.log('No GOOGLE_SERVICES_JSON: building without Android push notifications (the widget still works).');
console.log('SyncPair widget installed.');
