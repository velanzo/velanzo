// Keeps Velanzo's own files on this device so it opens and works without internet.
// When a new version is published, change VERSION: devices pick it up the next time they are online.
const VERSION = 'velanzo-2.2.0';
const CORE = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'css/app.css', 'worker.js',
  'js/barcode.js', 'js/bridge.js', 'js/core.js', 'js/charts.js', 'js/print.js', 'js/tour.js', 'js/setup.js', 'js/cloud.js', 'js/main.js',
  'js/views/dashboard.js', 'js/views/home.js', 'js/views/pos.js', 'js/views/sales.js', 'js/views/products.js', 'js/views/purchases.js',
  'js/views/labels.js', 'js/views/dispatch.js', 'js/views/stock.js', 'js/views/accounts.js', 'js/views/reports.js', 'js/views/settings.js', 'js/views/device.js', 'js/views/training.js', 'js/views/manage-data.js',
  'engine/index.js', 'engine/practice.js', 'engine/db.js', 'engine/util.js', 'engine/session.js', 'engine/sync.js', 'engine/syncer.js',
  'engine/routes/core.js', 'engine/routes/inventory.js', 'engine/routes/sales.js', 'engine/routes/data.js', 'engine/routes/activity.js', 'engine/checks.js', 'engine/routes/reports.js',
  'vendor/sqlite/index.mjs', 'vendor/sqlite/sqlite3.wasm', 'vendor/supabase.js',
];
// Always try the internet first for these (so a new cloud connection or version is seen at once).
const FRESH = ['index.html', 'config.js', './'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // the cloud is never cached
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length) || './';
  if (FRESH.includes(rel)) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // Everything else comes from this device (all files of one version together); anything new is kept for next time.
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
