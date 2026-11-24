// Service Worker — Bibbia Multilingue PRO (v17.0.4 — App Shell 100% Atomica Immutabile, Guardie Redirect & Bulk JSON, Icone Maskable)
const BM_SW_VERSION = "bm-pro-shell-v17-0-4";
const BM_API_CACHE = "bm-pro-api-v1";
const BM_API_CACHE_MAX = 150;
const BM_CRITICAL_SHELL = [
  "./index.html",
  "./jszip.min.js",
  "./manifest.json"
];
const BM_OPTIONAL_SHELL = [
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png"
];

function safeCachePut(cache, req, res) {
  if (!res || !res.ok || res.redirected) return Promise.resolve();
  return cache.put(req, res).catch(() => {});
}

async function precacheExact(cache, url) {
  const req = new Request(url, { cache: "reload" });
  const res = await fetch(req);
  if (!res || !res.ok || res.redirected) {
    throw new Error(`Precache non valida per ${url}`);
  }
  await cache.put(req, res);
}

function getCanonicalIndexUrl() {
  return new URL("./index.html", self.registration.scope).href;
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

// Esclude i download integrali GetBible (~5 MB: /v2/{code}.json) da BM_API_CACHE
// perché vengono già salvati in IndexedDB dall'app (mantiene in cache solo translations.json e i singoli capitoli).
function isBulkGetBibleJson(url) {
  return isExactOrSubHost(url.hostname, "api.getbible.net")
    && /^\/v2\/[^/]+\.json$/i.test(url.pathname)
    && !/^\/v2\/translations\.json$/i.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(BM_SW_VERSION);
    await Promise.all(
      BM_CRITICAL_SHELL.map((url) => precacheExact(cache, url))
    );
    await Promise.allSettled(
      BM_OPTIONAL_SHELL.map((url) => precacheExact(cache, url))
    );
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
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
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
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

  if (!url.protocol.startsWith("http")) return;
  if (isExactOrSubHost(url.hostname, "wol.jw.org") || isExactOrSubHost(url.hostname, "translate.googleapis.com")) return;
  if (isBulkGetBibleJson(url)) return;

  // 1. API Bibbie online (GetBible capitoli/catalogo & HelloAO): Network-First con cache API separata e cap FIFO
  if (isExactOrSubHost(url.hostname, "api.getbible.net") || isExactOrSubHost(url.hostname, "bible.helloao.org")) {
    let bgWork = Promise.resolve();
    const resPromise = (async () => {
      const cache = await caches.open(BM_API_CACHE);
      try {
        const net = await fetch(req);
        if (net && net.ok && !net.redirected) {
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

  // 2. Navigazione App Shell (HTML principale): Cache-First atomico dalla precache immutabile della release attiva.
  // Evita qualsiasi mismatch tra un index.html nuovo e jszip.min.js della release precedente: il cambio avviene atomicamente col nuovo SW.
  if (url.origin === self.location.origin && req.mode === "navigate") {
    const indexKey = getCanonicalIndexUrl();
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(indexKey) || await cache.match("./index.html");
      if (cached) return cached;
      try {
        const net = await fetch(indexKey, { cache: "no-cache" });
        if (net && net.ok && !net.redirected) {
          await safeCachePut(cache, indexKey, net.clone());
        }
        return net;
      } catch (_e) {
        return new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // 3. Risorse statiche same-origin (jszip.min.js, manifest.json, icone): Cache-First atomico dalla precache immutabile della release attiva
  if (url.origin === self.location.origin) {
    const canonicalShellKey = url.pathname.endsWith("/") ? getCanonicalIndexUrl() : (url.origin + url.pathname);
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(canonicalShellKey) || await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const net = await fetch(canonicalShellKey, { cache: "no-cache" });
        if (net && net.ok && !net.redirected) {
          await safeCachePut(cache, canonicalShellKey, net.clone());
        }
        return net;
      } catch (_e) {
        return new Response("Offline", { status: 503 });
      }
    })());
  }
});
