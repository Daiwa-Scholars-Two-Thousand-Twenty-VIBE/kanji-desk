// Offline support. The app's own files: network first, so a new version shows up straight
// away, with the cache as the fallback offline. Audio and radical images from WaniKani's file
// server: cache first, they never change. The API is never touched here; the app keeps its
// own copy of your data in IndexedDB.
const SHELL = "kanji-desk-shell-v1";
const MEDIA = "kanji-desk-media-v1";
const FILES = [
  "./",
  "index.html",
  "css/style.css",
  "vendor/wanakana.min.js",
  "js/check.js",
  "js/items.js",
  "js/session.js",
  "js/wk.js",
  "js/store.js",
  "js/demo.js",
  "js/app.js",
  "manifest.webmanifest",
  "favicon.svg",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "files.wanikani.com") {
    e.respondWith(
      caches.open(MEDIA).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
  );
});
