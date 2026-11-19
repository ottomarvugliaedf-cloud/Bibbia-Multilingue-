// Service Worker — Bibbia Multilingue PRO (v13 Offline Shell)
const BM_SW_VERSION = "bm-pro-shell-v13-1";
const BM_APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];
const BM_JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(BM_SW_VERSION);
    await Promise.allSettled(
      BM_APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))
    );
    // Pre-cache JSZip CDN così anche l'importazione EPUB/ZIP funziona offline in modalità aereo
    try {
      const resp = await fetch(BM_JSZIP_CDN, { mode: "cors", credentials: "omit" });
      if (resp && resp.ok) await cache.put(BM_JSZIP_CDN, resp.clone());
    } catch (_e) {
      try {
        const opaque = await fetch(new Request(BM_JSZIP_CDN, { mode: "no-cors" }));
        if (opaque) await cache.put(BM_JSZIP_CDN, opaque);
      } catch (_e2) {}
    }
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
        const hasJszip = reqs.some((r) => r.url.includes("jszip"));
        event.ports[0].postMessage({
          version: BM_SW_VERSION,
          cachedCount: reqs.length,
          hasJszip
        });
      } catch (_e) {
        event.ports[0].postMessage({ version: BM_SW_VERSION, cachedCount: 0, hasJszip: false });
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

  // 1. JSZip CDN: Cache-First (funziona istantaneamente anche offline)
  if (url.href === BM_JSZIP_CDN || url.pathname.endsWith("jszip.min.js")) {
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(req, { ignoreSearch: true }) || await cache.match(BM_JSZIP_CDN);
      if (cached) return cached;
      const net = await fetch(req);
      if (net && (net.ok || net.type === "opaque")) cache.put(req, net.clone());
      return net;
    })());
    return;
  }

  // 2. API Bibbie online (GetBible / HelloAO): Network-First con fallback Cache
  if (url.hostname.includes("api.getbible.net") || url.hostname.includes("bible.helloao.org")) {
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      try {
        const net = await fetch(req);
        if (net && net.ok) cache.put(req, net.clone());
        return net;
      } catch (_e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw _e;
      }
    })());
    return;
  }

  // 3. App Shell same-origin: Stale-While-Revalidate (avvio immediato offline + aggiornamento silente)
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(BM_SW_VERSION);
      const cached = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : null);
      const fetchPromise = fetch(req).then((net) => {
        if (net && net.ok) cache.put(req, net.clone());
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || new Response("Offline", { status: 503 });
    })());
  }
});
