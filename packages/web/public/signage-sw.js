/**
 * @file 店頭サイネージの再生のページを端末に取り置く（仕様書 第31.9.1節）。
 *
 * 範囲は `/signage/` だけ。つながらないまま電源を入れ直しても、取り置いたページ（HTML と画面の部品）を開き、
 * 取り置いた素材で流し続けられるようにする。API（`/v1/`）の答えは取り置かない（素材はページが自分で取り置く）。
 */

const PAGE_CACHE = 'm2o-signage-page';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;
  // ページそのもの: 先にネットワーク、つながらなければ取り置いた最後のページ
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(PAGE_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh.ok) await cache.put('/signage/play', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('/signage/play')) ?? Response.error();
      }
    })());
    return;
  }
  // 画面の部品（名前に版の印が入るため、中身は変わらない）: 取り置きを先に見る
  if (url.pathname.startsWith('/assets/') || url.pathname === '/icons.svg') {
    event.respondWith((async () => {
      const cache = await caches.open(PAGE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    })());
  }
});
