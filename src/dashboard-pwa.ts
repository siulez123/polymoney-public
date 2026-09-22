/** PWA assets / service worker for the Polymoney dashboard. */

export const DASHBOARD_MANIFEST = JSON.stringify(
  {
    name: "Polymoney",
    short_name: "Polymoney",
    description: "Control Center BTC Up/Down 5m",
    start_url: "/pnl",
    display: "standalone",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    lang: "pt-PT",
    icons: [
      {
        src: "/icon-app.png",
        sizes: "96x96",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  },
  null,
  2,
);

export const DASHBOARD_ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" rx="28" fill="#0b1220"/>
  <path d="M32 84 L64 28 L96 84 Z" stroke="#3b82f6" stroke-width="8" stroke-linejoin="round"/>
  <circle cx="64" cy="72" r="10" fill="#22c55e"/>
</svg>
`;

/** Service worker: Web Push (background) + page messages (foreground). */
export const DASHBOARD_SERVICE_WORKER = `/* polymoney dashboard sw v4 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    event.respondWith(fetch(event.request));
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'Polymoney', body: '', tag: 'polymoney-pnl', renotify: true, won: null };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    try {
      data.body = event.data ? event.data.text() : '';
    } catch (_) {}
  }
  const won = data.won === true;
  const lost = data.won === false;
  const icon = won ? '/icon-win.png' : lost ? '/icon-loss.png' : (data.icon || '/icon-app.png');
  const badge = won ? '/badge-win.png' : lost ? '/badge-loss.png' : data.badge;
  const color = won ? '#22c55e' : lost ? '#ef4444' : data.color;
  const title = data.title || (won ? 'WON' : lost ? 'LOSS' : 'Polymoney');
  const options = {
    body: data.body || '',
    tag: data.tag || 'polymoney-pnl',
    renotify: data.renotify !== false,
    icon: icon,
    vibrate: won ? [80, 40, 80] : lost ? [200, 80, 200, 80, 200] : [120, 60, 120],
    data: { url: '/pnl', won: data.won },
  };
  if (badge) options.badge = badge;
  if (color) options.color = color;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'notify') return;
  const won = data.won === true;
  const lost = data.won === false;
  const title = data.title || 'Polymoney';
  const options = Object.assign({
    icon: won ? '/icon-win.png' : lost ? '/icon-loss.png' : '/icon-app.png',
    vibrate: won ? [80, 40, 80] : lost ? [200, 80, 200] : [120, 60, 120],
  }, data.options || {});
  if (won) {
    options.badge = '/badge-win.png';
    options.color = '#22c55e';
  } else if (lost) {
    options.badge = '/badge-loss.png';
    options.color = '#ef4444';
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/pnl';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
`;

