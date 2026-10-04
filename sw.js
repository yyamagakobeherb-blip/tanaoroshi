// オフラインでも起動できるように、画面の部品を端末に保存しておく
const CACHE = 'tanaoroshi-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'api.js', 'util.js', 'export.js', 'demo-items.js', 'demo-backend.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// 画面の部品: 端末の保存分をすぐ返し、裏で新しい版を取りに行く（次回起動時に反映）
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
