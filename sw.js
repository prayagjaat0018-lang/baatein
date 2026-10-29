// Baatein service worker: app ko installable banata hai.
// Network-first: hamesha naya version lata hai, net na ho to purani saved copy dikhata hai.
const CACHE = 'baatein-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Chat connection (socket.io) aur non-GET ko bilkul mat chhedo
  if (req.method !== 'GET' || url.pathname.startsWith('/socket.io')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});

// ---------------- Push notifications (message + call) ----------------
const ICON = '/icons/icon-192.png';

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // App khuli aur dikh rahi hai to app khud ring/ping karti hai - double notification nahi
    const appVisible = wins.some((w) => w.visibilityState === 'visible');
    if (appVisible && d.type !== 'missed') return;

    const isCall = d.type === 'call';
    const tag = d.call_id ? 'call-' + d.call_id : 'chat-' + (d.conversation_id || 'x');
    await self.registration.showNotification(d.title || 'Baatein', {
      body: d.body || '',
      icon: ICON,
      badge: ICON,
      tag,
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [600, 300, 600, 300, 600, 300, 600, 300, 600] : [200, 100, 200],
      data: { cid: d.conversation_id, call_id: d.call_id || null, type: d.type },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = wins.find((x) => x.visibilityState === 'visible') || wins[0];
      try { await w.focus(); } catch (_) {}
      w.postMessage({ type: 'notif-click', conversation_id: data.cid, call_id: data.call_id });
      return;
    }
    await self.clients.openWindow('/?c=' + encodeURIComponent(data.cid || ''));
  })());
});
