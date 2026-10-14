/* PBCR 자재 재고 — 서비스 워커 (화면 오프라인 캐시) */
const CACHE = 'pbcr-v1';   // ★ 화면 파일 수정 후 배포할 때마다 숫자 올리기
const SHELL = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // 앱스 스크립트 API·외부 CDN은 건드리지 않음

  if (e.request.mode === 'navigate') {           // 페이지 열기: 온라인 우선, 실패 시 캐시
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
