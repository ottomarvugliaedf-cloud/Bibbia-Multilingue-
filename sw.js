// Service Worker — Bibbia Multilingue PRO (v13.8 — Installazione Atomica, 100% Locale)
const BM_SW_VERSION = "bm-pro-shell-v13-8";
const BM_CRITICAL_SHELL = [
  "./index.html",
  "./jszip.min.js",
  "./manifest.json"
];
const BM_OPTIONAL_SHELL = [
  "./",
  "./icon-192.png",
  "./icon-512.png"
];

function safeCachePut(cache, req, res) {
  return cache.put(req, res).catch(() => {});
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(BM_SW_VERSION);
    // File critici in modalità atomica: se uno manca o fallisce, l'installazione abortisce e resta attiva la versione precedente sana
    await Promise.all(
      BM_CRITICAL_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))
    );
    await Promise.allSettled(
      BM_OPTIONAL_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))
    );
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("bm-pro-") && k !== BM_SW_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_CACHE_STATUS" && event.ports && event.ports[0]) {
    (async () => {
      try {
        const cache = await caches.open(BM_SW_VERSION);
        const reqs = await cache.keys();
        const urls = reqs.map((r) => r.url);
        const criticalChecks = await Promise.all(
          BM_CRITICAL_SHELL.map((u) => cache.match(u, { ignoreSearch: true }))
        );
        const hasCoreShell = criticalChecks.every(Boolean);
        const hasJszip = urls.some((u) => u.includes("jszip.min.js"));
        event.ports[0].postMessage({
          version: BM_SW_VERSION,
          cachedCount: reqs.length,
          hasCoreShell,
          hasJszip
        });
      } catch (_e) {
        event.ports[0].postMessage({ version: BM_SW_VERSION, cachedCount: 0, hasCoreShell: false, hasJszip: false });
      }
    })();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Non intercettare streaming TTS, wol.jw.org o schemi non HTTP(S)
  if (!url.protocol.startsWith("http")) return;
  if (url.hostname.includes("wol.jw.org") || url.hostname.includes("translate.googleapis.com")) return;

  // 1. API Bibbie online (GetBible / HelloAO): Network-First con fallback Cache
  if (url.hostname.includes("api.getbible.net") || url.hostname.includes("bible.helloao.org")) {
    let bgWork = Promise.resolve();
    const resPromise = (async () => {
      const cache = await caches.open(BM_SW_VERSION);
      try {
        const net = await fetch(req);
        if (net && net.ok) bgWork = safeCachePut(cache, req, net.clone());
        return net;
      } catch (_e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw _e;
      }
    })();
    event.respondWith(resPromise);
    event.waitUntil(resPromise.then(() => bgWork).catch(() => {}));
    return;
  }

  // 2. App Shell same-origin (index.html, jszip.min.js, manifest.json, icone): Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    let bgWork = Promise.resolve();
    const resPromise = (async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : null);
      const fetchPromise = fetch(req).then((net) => {
        if (net && net.ok) return safeCachePut(cache, req, net.clone()).then(() => net);
        return net;
      }).catch(() => null);
      if (cached) {
        bgWork = fetchPromise;
        return cached;
      }
      return (await fetchPromise) || new Response("Offline", { status: 503 });
    })();
    event.respondWith(resPromise);
    event.waitUntil(resPromise.then(() => bgWork).catch(() => {}));
  }
});
