// 앱 화면 파일 캐시: 항상 최신 파일을 먼저 받아 오고(network-first), 인터넷이 없을 때만 저장본 사용.
// OpenAI·Google 요청은 건드리지 않음.
const CACHE = 'kfi-shell-v1-3-1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // cache:'no-cache' = 휴대폰에 저장된 옛 파일을 그냥 쓰지 말고 서버에 새 파일이 있는지 꼭 확인
    fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })).then((res) => {
      if (!res.ok) return res;
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
