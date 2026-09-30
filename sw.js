/* TrackPilot — Service Worker
 *
 * Ziel: Die App startet auch ohne Netz, und bereits angesehene Kartenkacheln
 * bleiben sichtbar. Für alles Eigene gilt "erst Netz, dann Cache", damit eine
 * neue Version sofort ankommt statt hinter einem alten Cache zu hängen.
 */

const VERSION = 'v32';
const SHELL = `trackpilot-shell-${VERSION}`;
const TILES = `trackpilot-tiles-${VERSION}`;
const DATA = `trackpilot-data-${VERSION}`;
const NETZ = `trackpilot-netz-${VERSION}`;
const KEEP = [SHELL, TILES, DATA, NETZ];

/* Die App hiess bis zur Umbenennung "Railnav" und lag unter /railnav/. Die
 * Caches von damals liegen auf derselben Herkunft und wuerden sonst ewig
 * liegenbleiben - deshalb wird der alte Praefix hier mit aufgeraeumt. */
const ALT_PRAEFIX = 'railnav-';

const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js',
  // Mit ?v=lapis, genau wie index.html und das Manifest es anfordern: Der Cache
  // vergleicht die volle Adresse, ohne den Zusatz fände er offline nichts.
  'manifest.webmanifest', 'icon.svg?v=lapis'
];

const TILE_HOSTS = ['tile.openstreetmap.org', 'tiles.openrailwaymap.org', 'server.arcgisonline.com',
  'geoservices.bayern.de'];
const MAX_TILES = 600;

/* Die Netzkacheln unter netz/ ändern sich nur, wenn werkzeug/netz-bauen.py neu
 * läuft — und dann wird hier ohnehin VERSION hochgezählt. Deshalb "erst Cache":
 * Für die übrigen eigenen Dateien gilt bewusst das Gegenteil, aber bei 300
 * Kacheln wäre eine Netzabfrage je Kachel nur Wartezeit ohne Gewinn. */
const MAX_NETZ = 500;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Einzeln ablegen: eine fehlende Datei soll nicht die ganze Installation kippen
    await Promise.allSettled(SHELL_FILES.map(f => cache.add(f)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => (n.startsWith('trackpilot-') || n.startsWith(ALT_PRAEFIX)) && !KEEP.includes(n))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

const MAX_DATA = 300;

async function networkFirst(request, cacheName, frisch, max) {
  const cache = await caches.open(cacheName);
  try {
    /* Eigene Dateien bewusst ohne HTTP-Cache holen. GitHub Pages setzt
     * Cache-Control max-age=600, dadurch kam eine neue Fassung auf dem Gerät bis
     * zu zehn Minuten später an — beim Entfernen der Zoomknöpfe fiel genau das
     * auf. Der Cache hier bleibt davon unberührt und dient weiter als
     * Offlinevorrat. */
    const res = frisch && request.method === 'GET'
      ? await fetch(request.url, { cache: 'reload', credentials: 'same-origin' })
      : await fetch(request);
    if (res && res.ok) {
      await cache.put(request, res.clone());
      if (max) trim(cacheName, max);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await caches.open(SHELL);
      const page = await shell.match('index.html') || await shell.match('./');
      if (page) return page;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    /* Nur echte Treffer ablegen. Die Kachel-Layer laden per CORS, der Status ist
     * also lesbar. Undurchsichtige Antworten (opaque) bleiben draußen: Sie können
     * eine 429- oder 5xx-Seite sein, und Chrome rechnet jede mit mehreren MB auf
     * den Speicher an, den sich alle Apps dieser Herkunft teilen. */
    if (res && res.ok) {
      cache.put(request, res.clone());
      trim(cacheName, max);
    }
    return res;
  } catch (err) {
    /* Scheitert irgendein Schritt des Zwischenspeichers, darf das die Kachel
     * nicht kosten: dann eben unverändert durchreichen. */
    return fetch(request);
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;

  if (url.origin === self.location.origin) {
    event.respondWith(url.pathname.includes('/netz/')
      ? cacheFirst(request, NETZ, MAX_NETZ)
      : networkFirst(request, SHELL, true));
  } else if (url.hostname === 'tiles.openfreemap.org') {
    /* Die dunkle Karte. Stil (/styles/dark) und Kachelbeschreibung (/planet)
     * haben feste Adressen, zeigen aber jede Woche auf einen neuen Datenstand
     * (/planet/20260927_080001_pt/…). Aus dem Cache zuerst hielte ein Gerät den
     * alten Verweis fest, bis die Kacheln dahinter gelöscht sind — deshalb diese
     * beiden "erst Netz". Kacheln, Schriften und Symbole liegen unter
     * versionierten Pfaden und ändern sich nie: "erst Cache". */
    const beschreibung = url.pathname.startsWith('/styles/') || url.pathname === '/planet';
    event.respondWith(beschreibung
      ? networkFirst(request, DATA, false, MAX_DATA)
      : cacheFirst(request, TILES, MAX_TILES));
  } else if (TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(cacheFirst(request, TILES, MAX_TILES));
  } else if (url.hostname === 'api.openrailwaymap.org') {
    event.respondWith(networkFirst(request, DATA, false, MAX_DATA));
  }
});
