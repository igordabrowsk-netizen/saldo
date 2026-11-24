// Saldo — Service Worker (offline, cache app-shell + biblioteki Firebase)
const CACHE = 'saldo-v18';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './icons.js',
  './app.js',
  './sync.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const FIREBASE = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(async (c) => {
    // Własne pliki muszą się zapisać — inaczej instalacja się nie uda i zostaje poprzednia, działająca wersja
    // cache: 'reload' — pomija pamięć HTTP przeglądarki, żeby nowa wersja nie zapisała starych plików
    await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Biblioteki Firebase (odpowiedzi „opaque” z innej domeny: zapis przez put, nie add)
    await Promise.all(FIREBASE.map((u) => fetch(new Request(u, { mode: 'no-cors' }))
      .then((res) => c.put(u, res)).catch(() => {})));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Sieć najpierw (świeże pliki), w razie braku sieci — cache.
// Do cache trafiają tylko poprawne odpowiedzi; strona główna jako zastępstwo tylko przy nawigacji.
// Z innych domen obsługujemy wyłącznie biblioteki Firebase (połączenia z bazą idą bezpośrednio).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  const lib = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  if (!own && !lib) return;
  // Biblioteki Firebase mają wersję w adresie (nie zmieniają się) — najpierw pamięć urządzenia,
  // żeby wolny internet nie wstrzymywał startu aplikacji
  if (lib) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
      return res;
    })));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if ((own && res.ok && res.type === 'basic') || (lib && (res.ok || res.type === 'opaque'))) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: own }).then((r) => {
        if (r) return r;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
