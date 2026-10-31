// Paradigm service worker: keeps the shop usable during network or server outages.
//   Pages, CSS, JS        -> served from cache instantly, refreshed in the background
//   Catalogue + settings  -> network first (4s timeout), last good copy if offline
//   Product photos        -> cache first (their URLs change whenever the photo changes)
//   Account data          -> network first, cached copy if offline (cleared on logout/login)
//   Everything else (POST, admin, payments) always goes to the network.
const VERSION = 'v1';
const SHELL = `prdgm-shell-${VERSION}`;
const DATA = 'prdgm-data-v1';
const IMAGES = 'prdgm-img-v1';
const USER = 'prdgm-user-v1';
const KEEP = [SHELL, DATA, IMAGES, USER];
const MAX_IMAGES = 160;

const SHELL_FILES = [
    '/index.html', '/Login.html', '/Signup.html', '/Profile.html', '/Orders.html', '/Info.html', '/Receipt.html', '/404.html',
    '/shop.js', '/ui.js', '/auth.js', '/analytics.js', '/pwa.js',
    '/css/tailwind.css', '/styles/menu.css', '/styles/shop.css', '/styles/account.css', '/styles/light.css', '/styles/perf.css',
    '/favicon.svg', '/site.webmanifest',
];
const USER_API = ['/api/auth/me', '/api/orders/mine', '/api/wishlist', '/api/profile', '/api/cart'];
const DATA_API = ['/api/products', '/api/store/settings'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        // One missing file must not break installation.
        await Promise.all(SHELL_FILES.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'clear-user-cache') event.waitUntil(caches.delete(USER));
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

async function networkFirst(request, cacheName, ms = 4000) {
    const cache = await caches.open(cacheName);
    try {
        const response = await Promise.race([fetch(request), timeout(ms)]);
        if (response.ok) cache.put(request, response.clone());
        else if (response.status >= 500) {
            const cached = await cache.match(request);
            if (cached) return cached; // server error: show the last good copy
        }
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw new Error('offline');
    }
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
        await cache.put(request, response.clone());
        trim(cacheName, MAX_IMAGES);
    }
    return response;
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request, { ignoreSearch: true });
    const refresh = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    }).catch(() => cached);
    return cached || refresh;
}

async function trim(cacheName, max) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

async function page(request) {
    try {
        return await networkFirst(request, SHELL, 4000);
    } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('/index.html')) || Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // Remote images (background, flags, placeholders): cache first so the look survives offline.
    if (url.origin !== self.location.origin) {
        if (request.destination === 'image') event.respondWith(cacheFirst(request, IMAGES).catch(() => Response.error()));
        return;
    }

    const path = url.pathname;
    if (path.startsWith('/api/')) {
        if (/^\/api\/products\/\d+\/(image|gallery\/\d+)$/.test(path)) {
            event.respondWith(cacheFirst(request, IMAGES));
        } else if (DATA_API.includes(path)) {
            event.respondWith(networkFirst(request, DATA));
        } else if (USER_API.includes(path)) {
            event.respondWith(networkFirst(request, USER));
        }
        return; // admin, payments, health, POSTs: network only
    }
    if (path === '/sw.js') return;
    if (url.searchParams.has('token')) return; // one-time email links are never stored
    if (request.mode === 'navigate') {
        event.respondWith(page(request));
        return;
    }
    event.respondWith(staleWhileRevalidate(request));
});
