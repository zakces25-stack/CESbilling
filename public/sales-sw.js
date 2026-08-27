/* CES Sales app — service worker.
 *
 * Registered from sales-app.html with scope '/sales-app.html', so it controls
 * ONLY the mobile app shell — never index.html, sales.html or the other pages
 * (their caching stays governed by .htaccess).
 *
 * Strategy:
 *  - App shell (sales-app.html): network-first, cache fallback → the app still
 *    opens with no signal; fresh deploys land on next online open.
 *  - Static same-origin assets (icons, manifest, logo): cache-first.
 *  - CDN scripts/fonts (jsdelivr, googleapis, gstatic): stale-while-revalidate.
 *  - Supabase (any *.supabase.co) and Turnstile: NEVER intercepted or cached —
 *    auth tokens and business data must not sit in Cache Storage.
 */
'use strict';

const VERSION = 'ces-sales-v1';
const SHELL = 'shell-' + VERSION;
const STATIC = 'static-' + VERSION;
const CDN = 'cdn-' + VERSION;

const PRECACHE = [
  '/sales-app.html',
  '/sales.webmanifest',
  '/sales-192.png',
  '/sales-512.png',
  '/sales-apple-touch-icon.png',
  '/ces_logo.png'
];
// The app is dead offline without these (supabase.createClient runs at the top
// of the inline script), so the shell cache must include them. Cached as
// opaque no-cors responses, which <script src> accepts.
const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(PRECACHE);
    const cdn = await caches.open(CDN);
    await Promise.all(CDN_PRECACHE.map(async (u) => {
      try { await cdn.add(new Request(u, { mode: 'no-cors' })); } catch (e) { /* non-fatal */ }
    }));
    // No skipWaiting() here: activation of an update is driven by the app's
    // "Update available → Reload" banner posting SKIP_WAITING.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Hands off anything Supabase or Turnstile — straight to network.
  if (url.hostname.endsWith('.supabase.co') || url.hostname === 'challenges.cloudflare.com') return;

  // App shell navigation: network-first with cache fallback. Only a 2xx
  // same-origin response may replace the cached shell — a 404 (which
  // .htaccess rewrites to the billing portal) or a 5xx/CDN error page must
  // never poison the offline copy.
  if (event.request.mode === 'navigate' || url.pathname === '/sales-app.html') {
    event.respondWith(
      fetch(event.request)
        .then(async (res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/sales-app.html', copy));
            return res;
          }
          const hit = await caches.match('/sales-app.html');
          return hit || res;
        })
        .catch(() => caches.match('/sales-app.html'))
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((hit) =>
        hit || fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC).then((c) => c.put(event.request, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // CDN (chart.js, supabase-js lib, fonts): stale-while-revalidate.
  if (/(^|\.)(jsdelivr\.net|googleapis\.com|gstatic\.com)$/.test(url.hostname)) {
    event.respondWith(
      caches.open(CDN).then(async (c) => {
        const hit = await c.match(event.request);
        const refetch = fetch(event.request).then((res) => {
          if (res.ok || res.type === 'opaque') c.put(event.request, res.clone());
          return res;
        }).catch(() => hit);
        return hit || refetch;
      })
    );
  }
});
