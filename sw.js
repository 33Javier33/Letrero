const CACHE_NAME = 'letrero-v48';

// Archivos locales que se cachean en la instalación
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './img/dreams1.png',
  './img/dreams2.png',
  './img/dreams-logo.png',
  './img/casino.jpg',
  './img/cards.jpg',
  './img/no-phone.png',
  './img/navidad.jpg',
  './img/dreams-santa.png',
  './img/navidad2.jpg',
  './img/anonuevo.jpg',
  './img/dreams-anonuevo.png',
  './css/tailwind.css',
  './css/fonts.css',
  './fonts/barlow-condensed-latin-700-normal.woff2',
  './fonts/barlow-condensed-latin-900-normal.woff2',
  './fonts/cinzel-latin-700-normal.woff2',
  './fonts/roboto-latin-400-normal.woff2',
  './fonts/roboto-latin-500-normal.woff2'
];

// Dentro del APK la app se sirve desde https://localhost con los archivos incluidos.
// Cuando hay internet, se descarga la última versión publicada y se usa en lugar de la incluida.
const IS_APK = self.location.hostname === 'localhost' && self.location.protocol === 'https:';
const REMOTE = 'https://letrero-nine.vercel.app/';
const REMOTE_CACHE = CACHE_NAME + '-remote';
const VERSION_KEY = './__remote_version__';
const CHECK_EVERY_MS = 10 * 60 * 1000;
let lastCheck = 0;

const versionNum = name => parseInt((String(name).match(/v(\d+)/) || [])[1] || '0', 10);
const localUrl = rel => new URL(rel, self.registration.scope).href;

async function storedInfo() {
  const r = await (await caches.open(REMOTE_CACHE)).match(localUrl(VERSION_KEY));
  if (!r) return null;
  try { return JSON.parse(await r.text()); } catch (e) { return null; }
}

async function checkRemoteUpdate(force) {
  if (!IS_APK) return;
  const now = Date.now();
  if (!force && now - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = now;
  try {
    const swText = await (await fetch(REMOTE + 'sw.js', { cache: 'no-store', mode: 'cors' })).text();
    const remoteName = (swText.match(/CACHE_NAME\s*=\s*'([^']+)'/) || [])[1];
    if (!remoteName) return;

    const cache = await caches.open(REMOTE_CACHE);
    const stored = await storedInfo();
    const current = Math.max(versionNum(CACHE_NAME), stored ? versionNum(stored.version) : 0);
    if (versionNum(remoteName) <= current) return;

    const listMatch = swText.match(/LOCAL_ASSETS\s*=\s*\[([\s\S]*?)\]/);
    const assets = (listMatch ? listMatch[1].match(/'([^']+)'/g) || [] : [])
      .map(s => s.slice(1, -1))
      .filter(p => p !== './');
    if (!assets.includes('./index.html')) return;

    const responses = await Promise.all(assets.map(async p => {
      const r = await fetch(new URL(p, REMOTE).href, { cache: 'no-store', mode: 'cors' });
      if (!r.ok) throw new Error('fetch ' + p + ' ' + r.status);
      return [p, new Response(await r.blob(), { headers: { 'Content-Type': r.headers.get('Content-Type') || '' } })];
    }));
    for (const [p, r] of responses) await cache.put(localUrl(p), r);
    await cache.put(localUrl(VERSION_KEY), new Response(JSON.stringify({ version: remoteName, at: Date.now() })));

    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'remote-updated', version: remoteName }));
  } catch (e) {
    // Sin internet o error de red: se sigue usando la versión que ya está guardada.
  }
}

async function fromRemoteCache(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.endsWith('/')) path += 'index.html';
  const cache = await caches.open(REMOTE_CACHE);
  if (!(await cache.match(localUrl(VERSION_KEY)))) return undefined;
  return cache.match(new URL(path, self.location.origin).href);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(LOCAL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== REMOTE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'check-remote-update') {
    const source = event.source;
    const loadedAt = event.data.loadedAt || 0;
    event.waitUntil(checkRemoteUpdate(true).then(storedInfo).then(info => {
      if (info && info.at > loadedAt && source) source.postMessage({ type: 'remote-updated', version: info.version });
    }));
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isLocal = url.origin === self.location.origin;
  if (isLocal && url.pathname.includes('/instalarapk/')) return;

  if (isLocal) {
    if (IS_APK && event.request.mode === 'navigate') event.waitUntil(checkRemoteUpdate(false));
    // Cache First: última versión descargada (APK), luego archivos propios, luego red
    event.respondWith(
      (IS_APK ? fromRemoteCache(event.request) : Promise.resolve(undefined))
        .then(r => r || caches.match(event.request, { ignoreSearch: true }))
        .then(cached => cached || fetch(event.request))
    );
  } else {
    // Network First para CDN (Tailwind, Google Fonts): intenta red, cae en caché si hay sin internet
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
