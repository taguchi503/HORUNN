/* ホルンれんしゅう v0.5.1 / GitHub Pages static-site OMR asset bridge.
   The user's score stays in the browser. This worker fetches published *code and
   model files*, not photos, from the upstream public Sheetscan distribution.
   No server-side processing. No GitHub Actions required by the user.
   Upstream assets are AGPL-3.0 and can change; see README.txt. */
const UPSTREAM = 'https://dsalex1.github.io/sheetscan/';
const ROOT = new URL('./', self.registration.scope);
const PREFIX = ROOT.pathname + '_omr/';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
function isolationHeaders(original) {
  const h = new Headers();
  for (const name of ['content-type', 'cache-control', 'last-modified', 'etag', 'accept-ranges']) {
    const value = original.headers.get(name); if (value) h.set(name,value);
  }
  h.set('Cross-Origin-Opener-Policy','same-origin');
  h.set('Cross-Origin-Embedder-Policy','require-corp');
  h.set('Cross-Origin-Resource-Policy','cross-origin');
  return h;
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin) return;
  if (url.pathname.startsWith(PREFIX)) {
    event.respondWith((async () => {
      const rest = url.pathname.slice(PREFIX.length) || 'index.html';
      const upstreamURL = new URL(rest + url.search,UPSTREAM);
      try {
        // GitHub Pages serves public resources with Access-Control-Allow-Origin: *.
        // CORS is essential: bypassing it would make the contents opaque.
        const response = await fetch(upstreamURL.toString(), {mode:'cors', credentials:'omit', cache:'default'});
        if (!response.ok) return new Response(`読譜エンジンが取得できません（HTTP ${response.status}）`,{status:502,headers:{'Content-Type':'text/plain; charset=utf-8'}});
        const h = isolationHeaders(response);
        if (rest === 'index.html' || rest === '') {
          let html = await response.text();
          // Our worker already sets cross-origin isolation headers. Do not let
          // upstream's COI service worker take over and disable the bridge.
          html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*coi-serviceworker\.min\.js["'][^>]*>\s*<\/script>/gi,'');
          // Upstream uses Vite base: './'; also cope with absolute asset URLs.
          html = html.replace(/(["'])\/sheetscan\//g, `$1${PREFIX}`);
          return new Response(html,{status:response.status,headers:h});
        }
        if (/(\.js|\.mjs|\.css|\.html)$/i.test(rest)) {
          // Most generated URLs are relative. Rewrite any absolute /sheetscan/
          // URLs in the upstream bundle for GitHub Pages' /<repo>/ paths.
          let source=await response.text();
          if(source.includes('/sheetscan/')) source=source.replaceAll('/sheetscan/',PREFIX);
          return new Response(source,{status:response.status,headers:h});
        }
        return new Response(response.body,{status:response.status,headers:h});
      } catch (error) {
        return new Response(`読譜エンジンの取得に失敗しました。ネット接続を確認してください。詳細: ${String(error)}`,{status:502,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
    })());
    return;
  }
  const ownNav = event.request.mode === 'navigate';
  const ownWorkerAsset = /\.(?:js|css|svg|webmanifest)$/i.test(url.pathname);
  if (ownNav || ownWorkerAsset) {
    event.respondWith((async () => {
      const response=await fetch(event.request);
      if (!response.ok || response.type === 'opaque') return response;
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers:isolationHeaders(response)});
    })());
  }
});
