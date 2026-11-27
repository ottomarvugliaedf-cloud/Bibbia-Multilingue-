// Service Worker — Bibbia Multilingue PRO (v18.0.2 — App Shell 100% Atomica Whitelist, Protezione Cataloghi API & Guardie Redirect/Type)
const BM_SW_VERSION = "bm-pro-shell-v18-0-2";
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

function getCanonicalUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

function getCanonicalIndexUrl() {
  return getCanonicalUrl("./index.html");
}

function getAllowedShellUrlSet() {
  const allowed = new Set();
  for (const path of BM_CRITICAL_SHELL) allowed.add(getCanonicalUrl(path));
  for (const path of BM_OPTIONAL_SHELL) allowed.add(getCanonicalUrl(path));
  return allowed;
}

function isExactOrSubHost(hostname, domain) {
  const h = String(hostname || "").toLowerCase();
  const d = String(domain || "").toLowerCase();
  return h === d || h.endsWith("." + d);
}

function isProtectedCatalogApiUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (isExactOrSubHost(u.hostname, "api.getbible.net") && /^\/v2\/translations\.json$/i.test(u.pathname)) {
      return true;
    }
    if (isExactOrSubHost(u.hostname, "bible.helloao.org") && /^\/api\/available_translations\.json$/i.test(u.pathname)) {
      return true;
    }
  } catch (_e) {}
  return false;
}

// Esclude i download integrali GetBible (~5 MB: /v2/{code}.json) da BM_API_CACHE
// perché vengono già salvati in IndexedDB dall'app (mantiene in cache solo translations.json e i singoli capitoli).
function isBulkGetBibleJson(url) {
  return isExactOrSubHost(url.hostname, "api.getbible.net")
    && /^\/v2\/[^/]+\.json$/i.test(url.pathname)
    && !/^\/v2\/translations\.json$/i.test(url.pathname);
}

function safeCachePut(cache, key, res) {
  if (!res || !res.ok || res.redirected) return Promise.resolve();
  if (res.type && res.type !== "basic" && res.type !== "cors") return Promise.resolve();
  return cache.put(key, res).catch(() => {});
}

async function precacheExact(cache, relPath) {
  const canonicalUrl = getCanonicalUrl(relPath);
  const res = await fetch(new Request(canonicalUrl, { cache: "reload" }));
  if (!res || !res.ok || res.redirected || (res.type && res.type !== "basic" && res.type !== "cors")) {
    throw new Error(`Precache non valida per ${relPath}`);
  }
  await cache.put(canonicalUrl, res);
}

async function pruneApiCache(cache) {
  try {
    const keys = await cache.keys();
    const evictable = keys.filter((k) => !isProtectedCatalogApiUrl(k.url));
    if (evictable.length > BM_API_CACHE_MAX) {
      const excess = evictable.length - BM_API_CACHE_MAX;
      await Promise.all(evictable.slice(0, excess).map((k) => cache.delete(k)));
    }
  } catch (_e) {}
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
        const jszipCanonical = getCanonicalUrl("./jszip.min.js");
        const [shellReqs, apiReqs, criticalChecks, jszipHit] = await Promise.all([
          shellCache.keys(),
          apiCache.keys(),
          Promise.all(BM_CRITICAL_SHELL.map((u) => shellCache.match(getCanonicalUrl(u)))),
          shellCache.match(jszipCanonical)
        ]);
        const hasCoreShell = criticalChecks.every(Boolean);
        const hasJszip = Boolean(jszipHit);
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
  if (isExactOrSubHost(url.hostname, "jw.org") || isExactOrSubHost(url.hostname, "translate.googleapis.com")) return;
  if (isBulkGetBibleJson(url)) return;

  // 1. API Bibbie online (GetBible capitoli/catalogo & HelloAO): Network-First con cache API separata e cataloghi protetti
  if (isExactOrSubHost(url.hostname, "api.getbible.net") || isExactOrSubHost(url.hostname, "bible.helloao.org")) {
    let bgWork = Promise.resolve();
    const resPromise = (async () => {
      const cache = await caches.open(BM_API_CACHE);
      try {
        const net = await fetch(req);
        if (net && net.ok && !net.redirected) {
          bgWork = safeCachePut(cache, req, net.clone()).then(() => pruneApiCache(cache));
          return net;
        }
        if (net && net.status >= 500) {
          const cached = await cache.match(req);
          if (cached) return cached;
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
  if (url.origin === self.location.origin && req.mode === "navigate") {
    const indexKey = getCanonicalIndexUrl();
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(indexKey);
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

  // 3. Risorse statiche same-origin (whitelist App Shell immutabile della release attiva)
  if (url.origin === self.location.origin) {
    const canonicalShellKey = url.pathname.endsWith("/") ? getCanonicalIndexUrl() : (url.origin + url.pathname);
    const allowedShell = getAllowedShellUrlSet();
    if (!allowedShell.has(canonicalShellKey)) return;
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(canonicalShellKey);
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
