/* TrackPilot — Höhendaten für das Querprofil
 *
 * Gelände (DGM1, 1 m Gitter) und Oberfläche mit Gebäuden und Bewuchs (DOM20,
 * 20 cm) der Bayerischen Vermessungsverwaltung, OpenData unter CC BY 4.0. Beide
 * liegen als GeoTIFF-Kacheln von 1 km × 1 km auf download1.bayernwolke.de —
 * ohne CORS-Freigabe. Die App holt sie deshalb über einen eigenen Cloudflare
 * Worker (werkzeug/proxy/worker.js). Der WMS liefert nur gerenderte Bilder,
 * und der Höhendienst der BVV lässt im Browser nur die eigenen Portale zu.
 *
 * Am 10.10.2026 nachgemessen:
 *
 *   DGM1   1000 × 1000 Float32, LZW, Streifen zu je 2 Zeilen, kein COG,
 *          1,5–3,9 MB je Kachel (Median 2,1 MB im Flachland, 3,5 MB in den Alpen)
 *   DOM20  5000 × 5000 Float32, LZW, intern in 256 × 256 Pixel gekachelt,
 *          13–64 MB je Kachel, rund 100 kB je Block von 51,2 × 51,2 m
 *
 * Vom DGM kommt deshalb die ganze Datei — eine schräge Linie bräuchte ohnehin
 * fast alle Streifen —, vom DOM per Range-Abfrage nur die Blöcke entlang der
 * Linie. Damit sind auch die rund 100 MB, die eine DOM-Kachel entpackt hätte,
 * kein Thema für den Speicher des Handys.
 *
 * Bewusst ohne geotiff.js und proj4: Der Aufbau ist bekannt und eng. Weicht
 * eine Datei davon ab, bricht das Lesen mit einer klaren Meldung ab, statt
 * still falsche Höhen zu liefern. Geprüft wird mit werkzeug/hoehen-pruefen.mjs.
 */

const HOEHEN = {
  /* Der Worker aus werkzeug/proxy/worker.js. Auch beim Entwickeln auf
   * localhost: Die CSP der App lässt nur https-Verbindungen zu, und der Worker
   * gibt localhost ohnehin frei. werkzeug/proxy/lokal.mjs ist nur zum Prüfen
   * des Workers selbst. */
  proxy: 'https://trackpilot-hoehen.steidl-michael2000.workers.dev',
  /* Nur für die Prüfung unter Node: Dort gilt kein CORS, und die Kacheln
   * kommen direkt vom Server der Vermessungsverwaltung. */
  direkt: false,
  geladen: 0          // Bytes über die Leitung, seit dem Start
};

const BVV_DOWNLOAD = 'https://download1.bayernwolke.de/a';

const HOEHEN_ARTEN = {
  dgm1: { aufloesung: 1, pixel: 1000, ganz: true,
    direkt: (e, n) => `${BVV_DOWNLOAD}/dgm/dgm1/${e}_${n}.tif` },
  dom20: { aufloesung: 0.2, pixel: 5000, ganz: false,
    direkt: (e, n) => `${BVV_DOWNLOAD}/dom20/DOM/32${e}_${n}_20_DOM.tif` }
};

/* ============================ UTM Zone 32 ============================
 * ETRS89 / UTM 32N (EPSG:25832). Krüger-Reihen bis n⁴ in der Form von
 * Karney (2011); innerhalb Bayerns weit unter einem Millimeter. Ganz Bayern
 * rechnet die Vermessungsverwaltung in Zone 32, auch östlich von 12° —
 * die Kacheln tragen deshalb überall die 32 im Namen. */

const UTM = (() => {
  const a = 6378137, f = 1 / 298.257222101;          // GRS80
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  return {
    a, f, n, k0: 0.9996, e0: 500000, l0: 9 * Math.PI / 180,
    A: a / (1 + n) * (1 + n2 / 4 + n4 / 64),
    alpha: [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180,
      13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440,
      61 * n3 / 240 - 103 * n4 / 140,
      49561 * n4 / 161280],
    beta: [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360,
      n2 / 48 + n3 / 15 - 437 * n4 / 1440,
      17 * n3 / 480 - 37 * n4 / 840,
      4397 * n4 / 161280],
    delta: [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45,
      7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45,
      56 * n3 / 15 - 136 * n4 / 35,
      4279 * n4 / 630]
  };
})();

/** Geografisch (Grad) → [Ost, Nord] in Metern. */
function utm32Hin(lat, lon) {
  const p = lat * Math.PI / 180, l = lon * Math.PI / 180 - UTM.l0;
  const ex = 2 * Math.sqrt(UTM.n) / (1 + UTM.n);     // erste Exzentrizität
  const t = Math.sinh(Math.atanh(Math.sin(p)) - ex * Math.atanh(ex * Math.sin(p)));
  const xi1 = Math.atan2(t, Math.cos(l));
  const eta1 = Math.atanh(Math.sin(l) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 4; j++) {
    xi += UTM.alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += UTM.alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [UTM.e0 + UTM.k0 * UTM.A * eta, UTM.k0 * UTM.A * xi];
}

/** [Ost, Nord] in Metern → [lat, lon] in Grad. */
function utm32Zurueck(e, n) {
  const xi = n / (UTM.k0 * UTM.A), eta = (e - UTM.e0) / (UTM.k0 * UTM.A);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 4; j++) {
    xi1 -= UTM.beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= UTM.beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let p = chi;
  for (let j = 1; j <= 4; j++) p += UTM.delta[j - 1] * Math.sin(2 * j * chi);
  return [p * 180 / Math.PI, (UTM.l0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1))) * 180 / Math.PI];
}

/** Länge eines kurzen Abschnitts auf dem Ellipsoid, [lat, lon] in Grad.
 *  Mit den Krümmungsradien in der Mitte; bis 10 km auf Zentimeter genau. */
function ellipsoidAbstand(a, b) {
  const pm = (a[0] + b[0]) / 2 * Math.PI / 180;
  const e2 = UTM.f * (2 - UTM.f);
  const w = Math.sqrt(1 - e2 * Math.sin(pm) ** 2);
  const M = UTM.a * (1 - e2) / (w * w * w), N = UTM.a / w;
  const dp = (b[0] - a[0]) * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
  return Math.hypot(M * dp, N * Math.cos(pm) * dl);
}

/* ============================ GeoTIFF ============================
 * Nur, was die beiden Produkte tatsächlich brauchen: ein einziges Bild,
 * Float32, LZW ohne Prädiktor, in Streifen oder Kacheln. */

const TIFF_GROESSE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

/** Liest den Kopf. lies(von, laenge) liefert ein Uint8Array.
 *
 *  Wo die Verzeichnisse stehen, ist nicht einheitlich: Bei der DGM1-Kachel
 *  636_5528 beginnt es bei Byte 8, bei 778_5292 erst kurz vor dem Dateiende.
 *  Gelesen wird deshalb aus den Stücken, die schon da sind, und nur, was
 *  fehlt, wird nachgeholt. */
async function tiffKopf(lies, anfang) {
  const stuecke = [{ von: 0, b: anfang || await lies(0, 16384) }];
  const bei = async (von, laenge) => {
    let s = stuecke.find(x => von >= x.von && von + laenge <= x.von + x.b.byteLength);
    if (!s) {
      s = { von, b: await lies(von, Math.max(laenge, 4096)) };
      if (s.b.byteLength < laenge) throw new Error('Höhendaten: TIFF-Datei abgeschnitten');
      stuecke.push(s);
    }
    return { dv: new DataView(s.b.buffer, s.b.byteOffset, s.b.byteLength), p: von - s.von };
  };

  const kopf = await bei(0, 8);
  const ord = kopf.dv.getUint16(0);
  if (ord !== 0x4949 && ord !== 0x4D4D) throw new Error('Höhendaten: keine TIFF-Datei');
  const le = ord === 0x4949;
  if (kopf.dv.getUint16(2, le) !== 42) throw new Error('Höhendaten: BigTIFF wird nicht gelesen');

  const ifd = kopf.dv.getUint32(4, le);
  const zahlStelle = await bei(ifd, 2);
  const anzahl = zahlStelle.dv.getUint16(zahlStelle.p, le);
  const verz = await bei(ifd + 2, 12 * anzahl + 4);
  const eintraege = {};
  for (let i = 0; i < anzahl; i++) {
    const o = verz.p + 12 * i;
    eintraege[verz.dv.getUint16(o, le)] = { typ: verz.dv.getUint16(o + 2, le), zahl: verz.dv.getUint32(o + 4, le), ort: o + 8 };
  }

  /* Werte bis vier Byte stehen im Eintrag selbst, längere an einer eigenen
   * Stelle, die wiederum irgendwo in der Datei liegen kann. */
  const lesen = async tag => {
    const e = eintraege[tag];
    if (!e || !TIFF_GROESSE[e.typ]) return null;
    const groesse = TIFF_GROESSE[e.typ] * e.zahl;
    let quelle = verz.dv, start = e.ort;
    if (groesse > 4) {
      const s = await bei(verz.dv.getUint32(e.ort, le), groesse);
      quelle = s.dv;
      start = s.p;
    }
    if (e.typ === 2) {
      let s = '';
      for (let k = 0; k < e.zahl; k++) s += String.fromCharCode(quelle.getUint8(start + k));
      return s.replace(/\0+$/, '');
    }
    const aus = new Array(e.zahl);
    for (let k = 0; k < e.zahl; k++) {
      const p = start + k * TIFF_GROESSE[e.typ];
      aus[k] = e.typ === 3 ? quelle.getUint16(p, le)
        : e.typ === 4 ? quelle.getUint32(p, le)
        : e.typ === 12 ? quelle.getFloat64(p, le)
        : quelle.getUint8(p);
    }
    return aus;
  };
  const eins = async (tag, vorgabe) => { const w = await lesen(tag); return w ? w[0] : vorgabe; };

  const k = {
    le,
    breite: await eins(256), hoehe: await eins(257),
    bits: await eins(258, 1), kompression: await eins(259, 1), praediktor: await eins(317, 1),
    format: await eins(339, 1), ebenen: await eins(277, 1),
    skala: await lesen(33550), tie: await lesen(33922),
    kacheln: !!eintraege[322]
  };
  if (k.kacheln) {
    k.bw = await eins(322); k.bh = await eins(323);
    k.offsets = await lesen(324); k.laengen = await lesen(325);
  } else {
    k.bw = k.breite; k.bh = await eins(278, k.hoehe);
    k.offsets = await lesen(273); k.laengen = await lesen(279);
  }
  k.quer = Math.ceil(k.breite / k.bw);

  if (k.bits !== 32 || k.format !== 3 || k.ebenen !== 1) {
    throw new Error(`Höhendaten: unerwartetes Format (${k.bits} bit, Typ ${k.format}, ${k.ebenen} Kanäle)`);
  }
  if (k.kompression !== 1 && k.kompression !== 5) throw new Error(`Höhendaten: Kompression ${k.kompression} wird nicht gelesen`);
  if (k.praediktor !== 1) throw new Error(`Höhendaten: Prädiktor ${k.praediktor} wird nicht gelesen`);
  if (!k.skala || !k.tie || !k.offsets || !k.laengen) throw new Error('Höhendaten: Georeferenz oder Blocktabelle fehlt');

  /* GeoKeys: Raster als Fläche (Tiepunkt an der Pixelecke) oder als Punkt
   * (Tiepunkt in der Pixelmitte), dazu das Koordinatensystem. Das DGM1 ist als
   * Fläche ausgezeichnet, und die XYZ-Fassung bestätigt das: Der erste Wert der
   * Kachel 636_5528 steht bei 636000,50 / 5528999,50. Der Höhendienst der BVV
   * setzt ihn dagegen auf die Ecke und liegt damit einen halben Meter versetzt
   * — wer beide vergleicht, sieht am Hang Unterschiede bis 1,7 m. */
  const geo = await lesen(34735) || [];
  const schluessel = id => {
    for (let i = 4; i + 3 < geo.length; i += 4) if (geo[i] === id && geo[i + 1] === 0) return geo[i + 3];
    return undefined;
  };
  const epsg = schluessel(3072);
  if (epsg !== undefined && epsg !== 25832) throw new Error(`Höhendaten: EPSG:${epsg} statt 25832`);
  k.versatz = schluessel(1025) === 2 ? 0 : 0.5;

  const nodata = await lesen(42113);
  k.nodata = nodata ? parseFloat(nodata) : NaN;
  return k;
}

/** TIFF-LZW (MSB zuerst, Codebreite 9–12 Bit mit vorgezogenem Wechsel). */
function lzwEntpacken(daten, soll) {
  const aus = new Uint8Array(soll);
  const vor = new Int16Array(4096);       // Vorgänger in der Kette
  const letztes = new Uint8Array(4096);   // letztes Byte des Eintrags
  const erstes = new Uint8Array(4096);    // erstes Byte des Eintrags
  const lang = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { vor[i] = -1; letztes[i] = i; erstes[i] = i; lang[i] = 1; }

  let naechster = 258, breite = 9, alt = -1, pos = 0, bit = 0;
  const bits = daten.length * 8;

  const schreiben = code => {
    const l = lang[code];
    let p = pos + l - 1;
    for (let c = code; c !== -1; c = vor[c], p--) if (p < soll) aus[p] = letztes[c];
    pos += l;
  };

  while (bit + breite <= bits && pos < soll) {
    const i = bit >> 3;
    const w = (daten[i] << 16) | ((daten[i + 1] || 0) << 8) | (daten[i + 2] || 0);
    const code = (w >> (24 - (bit & 7) - breite)) & ((1 << breite) - 1);
    bit += breite;

    if (code === 257) break;                         // Ende
    if (code === 256) { naechster = 258; breite = 9; alt = -1; continue; }
    if (alt === -1) { schreiben(code); alt = code; continue; }

    if (naechster < 4096) {
      vor[naechster] = alt;
      erstes[naechster] = erstes[alt];
      letztes[naechster] = code < naechster ? erstes[code] : erstes[alt];
      lang[naechster] = lang[alt] + 1;
      naechster++;
    }
    if (code >= naechster) throw new Error('Höhendaten: LZW-Strom beschädigt');
    schreiben(code);
    alt = code;
    if (naechster + 1 >= (1 << breite) && breite < 12) breite++;
  }
  return aus;
}

/* ============================ Kacheln und Blöcke ============================ */

const HOEHEN_KACHELN_MAX = 12;           // Kacheln samt Kopf; beim DGM mit Datei (bis 4 MB)
const HOEHEN_BLOECKE_MAX = 48 * 2 ** 20; // entpackte Blöcke, in Byte
const hoehenKacheln = new Map();          // "dgm1/636_5528" → Promise<Kachel|null>
const hoehenBloecke = new Map();          // "dgm1/636_5528#17" → Float32Array
let hoehenBloeckeByte = 0;

function hoehenAdresse(art, e, n) {
  return HOEHEN.direkt ? HOEHEN_ARTEN[art].direkt(e, n) : `${HOEHEN.proxy}/${art}/${e}_${n}.tif`;
}

/** Holt eine Datei oder einen Bytebereich daraus; null, wenn es sie nicht gibt. */
async function hoehenHolen(url, von, laenge) {
  const r = await fetch(url, laenge ? { headers: { Range: `bytes=${von}-${von + laenge - 1}` } } : {});
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Höhendaten: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  HOEHEN.geladen += b.byteLength;
  // Hat der Server den Bereich übergangen, kam die ganze Datei
  return laenge && r.status !== 206 ? b.subarray(von, von + laenge) : b;
}

/* ---- Vorrat auf dem Gerät ----
 * DGM-Kacheln bleiben in IndexedDB: Ein zweites Profil in derselben Gegend ist
 * dann auch nach einem Neustart sofort da, und ohne Netz. Datei und Zeitpunkt
 * der letzten Nutzung liegen getrennt wie bei den KML-Dateien — das Merken der
 * Nutzung schreibt ein paar Byte statt wieder die ganze Kachel. Die am längsten
 * unbenutzten gehen zuerst. Vom DOM wird nichts abgelegt: 13–64 MB je Kachel.
 * Ohne IndexedDB (privates Fenster, gesperrt) geht es eben ohne Vorrat. */
const HOEHEN_DB = 'trackpilot-hoehen';
const HOEHEN_VORRAT_MAX = 40;            // rund 80–150 MB
let hoehenDbVersprechen = null;

function hoehenDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!hoehenDbVersprechen) {
    hoehenDbVersprechen = new Promise(ok => {
      let anfrage;
      try { anfrage = indexedDB.open(HOEHEN_DB, 1); } catch { ok(null); return; }
      anfrage.onupgradeneeded = () => {
        anfrage.result.createObjectStore('dateien');
        anfrage.result.createObjectStore('genutzt');
      };
      anfrage.onsuccess = () => ok(anfrage.result);
      anfrage.onerror = () => ok(null);
      anfrage.onblocked = () => ok(null);
    });
  }
  return hoehenDbVersprechen;
}

async function vorratLesen(schluessel) {
  try {
    const db = await hoehenDb();
    if (!db) return null;
    const daten = await new Promise((ok, fehl) => {
      const r = db.transaction('dateien').objectStore('dateien').get(schluessel);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fehl(r.error);
    });
    if (!daten) return null;
    db.transaction('genutzt', 'readwrite').objectStore('genutzt').put(Date.now(), schluessel);
    return new Uint8Array(daten);
  } catch {
    return null;
  }
}

async function vorratSchreiben(schluessel, bytes) {
  try {
    const db = await hoehenDb();
    if (!db) return;
    await new Promise((ok, fehl) => {
      const tx = db.transaction(['dateien', 'genutzt'], 'readwrite');
      tx.objectStore('dateien').put(bytes.slice().buffer, schluessel);
      tx.objectStore('genutzt').put(Date.now(), schluessel);
      tx.oncomplete = ok;
      tx.onerror = tx.onabort = () => fehl(tx.error);     // auch: Speicher voll
    });
    // Aufräumen: Schlüssel und Zeiten kommen in derselben Reihenfolge zurück
    const tx = db.transaction(['dateien', 'genutzt'], 'readwrite');
    const genutzt = tx.objectStore('genutzt');
    const schluesselListe = genutzt.getAllKeys(), zeiten = genutzt.getAll();
    zeiten.onsuccess = () => {
      const alt = schluesselListe.result.map((s, i) => [s, zeiten.result[i]]).sort((a, b) => a[1] - b[1]);
      for (const [s] of alt.slice(0, Math.max(0, alt.length - HOEHEN_VORRAT_MAX))) {
        genutzt.delete(s);
        tx.objectStore('dateien').delete(s);
      }
    };
  } catch {
    // Kein Platz oder gesperrt: Die Kachel ist trotzdem geladen, nur nicht gemerkt
  }
}

/** Lädt Kopf (und beim DGM die Datei) einer Kachel; null, wenn sie fehlt. */
function hoehenKachel(art, e, n) {
  const schluessel = `${art}/${e}_${n}`;
  const bekannt = hoehenKacheln.get(schluessel);
  if (bekannt) {
    hoehenKacheln.delete(schluessel);        // nach hinten: zuletzt benutzt
    hoehenKacheln.set(schluessel, bekannt);
    return bekannt;
  }

  const laden = (async () => {
    const def = HOEHEN_ARTEN[art], url = hoehenAdresse(art, e, n);
    let lies, anfang;
    if (def.ganz) {
      let datei = await vorratLesen(schluessel);
      if (!datei) {
        datei = await hoehenHolen(url);
        if (!datei) return null;             // keine Kachel: außerhalb Bayerns
        vorratSchreiben(schluessel, datei);  // im Hintergrund
      }
      lies = async (von, laenge) => datei.subarray(von, Math.min(von + laenge, datei.byteLength));
    } else {
      anfang = await hoehenHolen(url, 0, 16384);
      if (!anfang) return null;
      lies = async (von, laenge) => {
        const b = await hoehenHolen(url, von, laenge);
        if (!b) throw new Error(`Höhendaten: ${schluessel} verschwunden`);
        return b;
      };
    }
    const kopf = await tiffKopf(lies, anfang);

    /* Wo liegt die Kachel im durchgehenden Pixelraster? Spalte C und Zeile R
     * (von Süden gezählt) haben ihre Mitte bei ((C + v)·Auflösung, (R + v)·Auflösung). */
    const res = def.aufloesung, npx = def.pixel;
    if (kopf.breite !== npx || kopf.hoehe !== npx || Math.abs(kopf.skala[0] - res) > 1e-9 || Math.abs(kopf.skala[1] - res) > 1e-9) {
      throw new Error(`Höhendaten: ${schluessel} hat ein anderes Raster (${kopf.breite} px, ${kopf.skala[0]} m)`);
    }
    const v = kopf.versatz;
    const links = Math.round(kopf.tie[3] / res - kopf.tie[0]) - e * npx;
    const oben = Math.round(kopf.tie[4] / res + kopf.tie[1] - 2 * v) - n * npx;
    const schema = { versatz: v, links, oben };
    if (!def.schema) def.schema = schema;
    else if (def.schema.versatz !== v || def.schema.links !== links || def.schema.oben !== oben) {
      throw new Error(`Höhendaten: ${schluessel} liegt anders im Raster als die übrigen Kacheln`);
    }
    return { schluessel, art, e, n, kopf, lies };
  })();

  hoehenKacheln.set(schluessel, laden);
  laden.catch(() => hoehenKacheln.delete(schluessel));   // beim nächsten Mal neu versuchen
  while (hoehenKacheln.size > HOEHEN_KACHELN_MAX) hoehenKacheln.delete(hoehenKacheln.keys().next().value);
  return laden;
}

function blockEntpacken(kopf, roh, i) {
  const zeilen = kopf.kacheln ? kopf.bh : Math.min(kopf.bh, kopf.hoehe - i * kopf.bh);
  const soll = kopf.bw * zeilen * 4;
  if (!roh || !roh.length) return new Float32Array(soll / 4).fill(NaN);   // leerer Block
  const bytes = kopf.kompression === 5 ? lzwEntpacken(roh, soll) : roh.slice(0, soll);
  if (!kopf.le) {
    for (let p = 0; p < soll; p += 4) {
      let t = bytes[p]; bytes[p] = bytes[p + 3]; bytes[p + 3] = t;
      t = bytes[p + 1]; bytes[p + 1] = bytes[p + 2]; bytes[p + 2] = t;
    }
  }
  const werte = new Float32Array(bytes.buffer, bytes.byteOffset, soll / 4);
  if (!Number.isNaN(kopf.nodata)) for (let p = 0; p < werte.length; p++) if (werte[p] === kopf.nodata) werte[p] = NaN;
  return werte;
}

function blockMerken(schluessel, werte) {
  hoehenBloecke.set(schluessel, werte);
  hoehenBloeckeByte += werte.byteLength;
  for (const [s, w] of hoehenBloecke) {
    if (hoehenBloeckeByte <= HOEHEN_BLOECKE_MAX) break;
    hoehenBloecke.delete(s);
    hoehenBloeckeByte -= w.byteLength;
  }
}

/** Einfache Warteschlange: höchstens n Aufgaben gleichzeitig. */
async function hoehenParallel(liste, n, aufgabe) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, async () => {
    while (i < liste.length) await aufgabe(liste[i++]);
  }));
}

/** Liefert die genannten Blöcke einer Kachel entpackt, als Map Index → Werte.
 *  Beim DOM werden benachbarte Blöcke zu einer Abfrage zusammengelegt. Die
 *  Map hält sie fest, auch wenn der Zwischenspeicher sie für ein langes Profil
 *  schon wieder verwerfen muss. */
async function hoehenBloeckeLaden(kachel, indizes) {
  const k = kachel.kopf, raus = new Map(), fehlen = [];
  for (const i of indizes) {
    const da = hoehenBloecke.get(`${kachel.schluessel}#${i}`);
    if (da) raus.set(i, da);
    else fehlen.push(i);
  }
  if (!fehlen.length) return raus;
  fehlen.sort((a, b) => k.offsets[a] - k.offsets[b]);

  const gruppen = [];
  for (const i of fehlen) {
    const von = k.offsets[i], bis = von + k.laengen[i];
    const g = gruppen[gruppen.length - 1];
    if (g && von - g.bis < 65536 && bis - g.von < 4 * 2 ** 20) { g.bis = Math.max(g.bis, bis); g.indizes.push(i); }
    else gruppen.push({ von, bis, indizes: [i] });
  }
  await hoehenParallel(gruppen, 4, async g => {
    const b = g.bis > g.von ? await kachel.lies(g.von, g.bis - g.von) : new Uint8Array(0);
    for (const i of g.indizes) {
      const roh = b.subarray(k.offsets[i] - g.von, k.offsets[i] - g.von + k.laengen[i]);
      const werte = blockEntpacken(k, roh, i);
      blockMerken(`${kachel.schluessel}#${i}`, werte);
      raus.set(i, werte);
    }
  });
  return raus;
}

/* ============================ Abgreifen ============================ */

/** Höhen an UTM-Koordinaten (Float64Array ost, nord). Verfahren „bilinear"
 *  oder „nachbar". Wo es keine Daten gibt (außerhalb Bayerns, Lücke), NaN. */
async function hoehenWerte(art, ost, nord, verfahren = 'bilinear') {
  const def = HOEHEN_ARTEN[art], res = def.aufloesung, npx = def.pixel;
  const anzahl = ost.length;
  const aus = new Float32Array(anzahl).fill(NaN);
  if (!anzahl) return aus;

  /* Wie das Raster liegt, steht erst im Kopf einer Kachel. */
  if (!def.schema) {
    const versucht = new Set();
    for (let i = 0; i < anzahl && !def.schema && versucht.size < 8; i++) {
      const s = `${Math.floor(ost[i] / 1000)}_${Math.floor(nord[i] / 1000)}`;
      if (versucht.has(s)) continue;
      versucht.add(s);
      await hoehenKachel(art, Math.floor(ost[i] / 1000), Math.floor(nord[i] / 1000));
    }
    if (!def.schema) return aus;
  }
  const { versatz: v, links, oben } = def.schema;
  const ort = (C, R) => {
    const e = Math.floor((C - links) / npx), n = Math.floor((R - oben + npx - 1) / npx);
    return { e, n, c: C - e * npx - links, r: n * npx + oben - R };
  };

  /* Welche Pixel braucht jeder Punkt? Beim bilinearen Abgreifen die vier um
   * ihn herum — die können in der Nachbarkachel liegen. */
  const nachbar = verfahren === 'nachbar';
  const pix = new Int32Array(anzahl * 2);
  const gew = new Float32Array(anzahl * 2);
  for (let i = 0; i < anzahl; i++) {
    const fx = ost[i] / res - v, fy = nord[i] / res - v;
    const C = nachbar ? Math.round(fx) : Math.floor(fx), R = nachbar ? Math.round(fy) : Math.floor(fy);
    pix[2 * i] = C; pix[2 * i + 1] = R;
    gew[2 * i] = fx - C; gew[2 * i + 1] = fy - R;
  }
  const versatz = nachbar ? [[0, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];

  const bedarf = new Map();      // Kachel → Set der Blöcke
  for (let i = 0; i < anzahl; i++) {
    for (const [dc, dr] of versatz) {
      const o = ort(pix[2 * i] + dc, pix[2 * i + 1] + dr);
      const s = `${o.e}_${o.n}`;
      if (!bedarf.has(s)) bedarf.set(s, { e: o.e, n: o.n, pixel: [] });
      bedarf.get(s).pixel.push(o.c, o.r);
    }
  }

  const geladen = new Map();     // Kachel → { kopf, bloecke }
  await hoehenParallel([...bedarf.values()], 4, async b => {
    const kachel = await hoehenKachel(art, b.e, b.n);
    if (!kachel) return;
    const k = kachel.kopf, noetig = new Set();
    for (let j = 0; j < b.pixel.length; j += 2) {
      noetig.add(Math.floor(b.pixel[j + 1] / k.bh) * k.quer + Math.floor(b.pixel[j] / k.bw));
    }
    geladen.set(`${b.e}_${b.n}`, { kopf: k, bloecke: await hoehenBloeckeLaden(kachel, noetig) });
  });

  const wert = (C, R) => {
    const o = ort(C, R);
    const g = geladen.get(`${o.e}_${o.n}`);
    if (!g) return NaN;
    const k = g.kopf;
    const block = g.bloecke.get(Math.floor(o.r / k.bh) * k.quer + Math.floor(o.c / k.bw));
    return block ? block[(o.r % k.bh) * k.bw + (o.c % k.bw)] : NaN;
  };

  for (let i = 0; i < anzahl; i++) {
    const C = pix[2 * i], R = pix[2 * i + 1];
    if (nachbar) { aus[i] = wert(C, R); continue; }
    const tx = gew[2 * i], ty = gew[2 * i + 1];
    const w = [wert(C, R), wert(C + 1, R), wert(C, R + 1), wert(C + 1, R + 1)];
    const g = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    if (w.every(Number.isFinite)) aus[i] = w[0] * g[0] + w[1] * g[1] + w[2] * g[2] + w[3] * g[3];
    else {
      // Am Rand einer Lücke: der nächstgelegene gültige Nachbar
      let best = -1;
      for (let j = 0; j < 4; j++) if (Number.isFinite(w[j]) && (best < 0 || g[j] > g[best])) best = j;
      if (best >= 0) aus[i] = w[best];
    }
  }
  return aus;
}

/** Profil entlang eines Linienzugs [[lat, lon], …].
 *  Stützpunkte gleichmäßig je Abschnitt, höchstens maxPunkte insgesamt. */
async function hoehenProfil(punkte, art, { abstand, maxPunkte = 8000 } = {}) {
  if (!punkte || punkte.length < 2) return null;
  const utm = punkte.map(p => utm32Hin(p[0], p[1]));
  const laengen = [];
  let gesamt = 0;
  for (let i = 1; i < punkte.length; i++) {
    const l = ellipsoidAbstand(punkte[i - 1], punkte[i]);
    laengen.push(l);
    gesamt += l;
  }
  let schritt = abstand || HOEHEN_ARTEN[art].aufloesung;
  if (gesamt / schritt > maxPunkte) schritt = gesamt / maxPunkte;

  const station = [], ost = [], nord = [], ecken = [0];
  let s0 = 0;
  laengen.forEach((L, i) => {
    const stuecke = Math.max(1, Math.ceil(L / schritt));
    for (let j = i ? 1 : 0; j <= stuecke; j++) {     // Eckpunkt nur einmal
      const t = j / stuecke;
      station.push(s0 + t * L);
      ost.push(utm[i][0] + t * (utm[i + 1][0] - utm[i][0]));
      nord.push(utm[i][1] + t * (utm[i + 1][1] - utm[i][1]));
    }
    s0 += L;
    ecken.push(s0);
  });

  const vorher = HOEHEN.geladen;
  const ostF = Float64Array.from(ost), nordF = Float64Array.from(nord);
  const hoehe = await hoehenWerte(art, ostF, nordF);
  return { art, station: Float64Array.from(station), ost: ostF, nord: nordF, hoehe, ecken,
    laenge: gesamt, schritt, geladen: HOEHEN.geladen - vorher };
}

// Für die Prüfung unter Node (werkzeug/hoehen-pruefen.mjs); im Browser ohne Wirkung
if (typeof module === 'object' && module.exports) {
  module.exports = { HOEHEN, HOEHEN_ARTEN, utm32Hin, utm32Zurueck, ellipsoidAbstand,
    lzwEntpacken, tiffKopf, hoehenKachel, hoehenWerte, hoehenProfil };
}
