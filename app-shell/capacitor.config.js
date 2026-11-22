// Native shell that loads the live SyncPair server (so web updates reach the app without a rebuild).
const url = process.env.SERVER_URL;
if (!url) throw new Error('Set SERVER_URL to your deployed server, e.g. https://syncpair.onrender.com');
module.exports = {
  appId: 'com.syncpair.app',
  appName: 'SyncPair',
  webDir: 'www',
  server: { url, cleartext: false },
  ios: { contentInset: 'always' },
  android: { allowMixedContent: false }
};
