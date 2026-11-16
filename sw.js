/* Юнитка — service worker: приложение открывается без интернета.
   ВАЖНО: при КАЖДОЙ выкладке повышай VERSION (v1 → v2 → v3 ...),
   иначе телефон будет показывать старую версию. */
const VERSION = "v1";
const CACHE = "unitka-" + VERSION;

// Файлы приложения — ровно так, как они подключены в index.html
const APP_FILES = [
  "./",
  "index.html",
  "style.css?v=6",
  "demo-data.js?v=6",
  "app.js?v=6",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("unitka-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  // 1) Страница: сначала интернет (свежая версия), без сети — из памяти
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => { putCopy("index.html", res); return res; })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // 2) Данные data.enc: сначала интернет, без сети — последние сохранённые
  if (same && url.pathname.endsWith("/data.enc")) {
    e.respondWith(
      fetch(req).then((res) => { if (res.ok) putCopy("data.enc", res); return res; })
        .catch(() => caches.match("data.enc").then((r) => r || Response.error()))
    );
    return;
  }

  // 3) Файлы приложения и шрифты: сначала из памяти (быстро), если нет — из интернета и запомнить
  const font = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (same || font) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") putCopy(req, res);
        return res;
      }))
    );
  }
});

function putCopy(key, res) {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(key, copy));
}
