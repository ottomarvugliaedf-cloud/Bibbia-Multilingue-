// Service Worker — Bibbia Multilingue PRO (v14.7 — Voci TTS per Lingua con Fallback a 3 Stadi, Fix 1-Cap & EPUB)
const BM_SW_VERSION = "bm-pro-shell-v14-7";
const BM_API_CACHE = "bm-pro-api-v1";
const BM_API_CACHE_MAX = 150;
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

async function pruneApiCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > BM_API_CACHE_MAX) {
      const excess = keys.length - BM_API_CACHE_MAX;
      await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
    }
  } catch (_e) {}
}

function isExactOrSubHost(hostname, domain) {
  const h = String(hostname || "").toLowerCase();
  const d = String(domain || "").toLowerCase();
  return h === d || h.endsWith("." + d);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(BM_SW_VERSION);
    // File critici in modalità atomica: se uno manca o fallisce, resta attiva la versione precedente sana
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
    // Elimina solo vecchie cache della shell preservando la cache persistente delle API bibliche
    await Promise.all(
      keys
        .filter((k) => k.startsWith("bm-pro-") && k !== BM_SW_VERSION && k !== BM_API_CACHE)
        .map((k) => caches.delete(k))
    );
    const apiCache = await caches.open(BM_API_CACHE);
    await pruneApiCache(apiCache);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "GET_CACHE_STATUS" && event.ports && event.ports[0]) {
    const port = event.ports[0];
    const task = (async () => {
      try {
        const [shellCache, apiCache] = await Promise.all([
          caches.open(BM_SW_VERSION),
          caches.open(BM_API_CACHE)
        ]);
        const [shellReqs, apiReqs, criticalChecks] = await Promise.all([
          shellCache.keys(),
          apiCache.keys(),
          Promise.all(BM_CRITICAL_SHELL.map((u) => shellCache.match(u, { ignoreSearch: true })))
        ]);
        const hasCoreShell = criticalChecks.every(Boolean);
        const hasJszip = shellReqs.some((r) => new URL(r.url).pathname.endsWith("/jszip.min.js") || r.url.endsWith("jszip.min.js"));
        port.postMessage({
          version: BM_SW_VERSION,
          cachedCount: shellReqs.length,
          apiCachedCount: apiReqs.length,
          hasCoreShell,
          hasJszip
        });
      } catch (_e) {
        port.postMessage({
          version: BM_SW_VERSION,
          cachedCount: 0,
          apiCachedCount: 0,
          hasCoreShell: false,
          hasJszip: false
        });
      }
    })();
    if (typeof event.waitUntil === "function") event.waitUntil(task);
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Non intercettare streaming TTS, wol.jw.org o schemi non HTTP(S)
  if (!url.protocol.startsWith("http")) return;
  if (isExactOrSubHost(url.hostname, "wol.jw.org") || isExactOrSubHost(url.hostname, "translate.googleapis.com")) return;

  // 1. API Bibbie online (GetBible / HelloAO): Network-First con cache API separata e cap FIFO
  if (isExactOrSubHost(url.hostname, "api.getbible.net") || isExactOrSubHost(url.hostname, "bible.helloao.org")) {
    let bgWork = Promise.resolve();
    const resPromise = (async () => {
      const cache = await caches.open(BM_API_CACHE);
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          bgWork = safeCachePut(cache, req, net.clone()).then(() => pruneApiCache(cache));
        }
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

  // 2. App Shell same-origin (index.html, jszip.min.js, manifest.json, icone): Stale-While-Revalidate con chiave canonica
  if (url.origin === self.location.origin) {
    let bgWork = Promise.resolve();
    const canonicalShellKey = url.origin + url.pathname;
    const resPromise = (async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(canonicalShellKey) ||
        await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : null);
      const fetchPromise = fetch(req.mode === "navigate" ? canonicalShellKey : req, { cache: "no-cache" }).then((net) => {
        if (net && net.ok) return safeCachePut(cache, canonicalShellKey, net.clone()).then(() => net);
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
