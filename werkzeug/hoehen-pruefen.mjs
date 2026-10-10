/* Prüft hoehen.js gegen unabhängige Quellen — unter Node, wo kein CORS gilt.
 *
 *   node werkzeug/hoehen-pruefen.mjs
 *
 * 1. UTM gegen proj4 2.6.2 (die Werte unten wurden einmalig damit gerechnet)
 * 2. Rundlauf geografisch → UTM → geografisch über ganz Bayern
 * 3. DGM1 gegen die XYZ-Fassung derselben Kachel: Die nennt zu jedem Wert die
 *    Koordinate im Klartext und ist damit der Maßstab für die Lage im Raster.
 *    Verglichen werden die ersten Zeilen (aus dem Anfang der ZIP-Datei).
 * 4. DGM1 gegen den Höhendienst der BVV, als zweite Gegenprobe. Der Dienst
 *    nimmt den nächsten Rasterwert, rundet auf 0,1 m — und liegt einen halben
 *    Meter versetzt: Er ordnet jeden Wert der Pixelecke zu, während GeoTIFF und
 *    XYZ ihn in die Pixelmitte setzen (636000,50 / 5528999,50 für den ersten
 *    Wert der Kachel 636_5528). Am 10.10.2026 traf er mit diesem Versatz 400 von
 *    400 Stellen, ohne nur 308 bzw. 120.
 * 5. Über eine Kachelgrenze hinweg
 * 6. DOM20: Datenmenge, Dauer und DOM − DGM
 *
 * Der Höhendienst dient hier allein als Prüfwert; aus der App heraus wird er
 * nicht benutzt (im Browser lässt er nur die Portale der BVV und localhost zu).
 */

import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const H = require('../hoehen.js');
H.HOEHEN.direkt = true;

// [lat, lon, Ost, Nord] aus proj4 2.6.2, EPSG:4326 → EPSG:25832
const REFERENZ = [
  [49.8918, 10.8862, 635477.4426, 5528306.4863],
  [47.63, 12.98, 798984.8509, 5282855.5637],
  [49.79, 9.95, 568379.3058, 5515715.3071],
  [50.31, 11.92, 707902.6382, 5577177.1204],
  [48.574, 13.46, 828947.394, 5389710.0461],
  [47.55, 9.68, 551164.3845, 5266510.596],
  [48, 9, 500000, 5316300.2243],
  [50.5, 13.9, 847432.3489, 5605701.669]
];

const HOEHENDIENST = 'https://geoservices.bayern.de/bvvapi/od/hoehen/v1/elevation/list';

let fehler = 0;
const pruefe = (ok, text) => {
  console.log(`${ok ? 'ok    ' : 'FEHLER'}  ${text}`);
  if (!ok) fehler++;
};
const zahl = (x, stellen = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
const quantil = (werte, q) => {
  const s = [...werte].filter(Number.isFinite).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Fester Zufall, damit jeder Lauf dieselben Stellen prüft (mulberry32). */
function zufall(saat) {
  return () => {
    saat |= 0; saat = saat + 0x6D2B79F5 | 0;
    let t = Math.imul(saat ^ saat >>> 15, 1 | saat);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function hoehendienst(ost, nord) {
  const aus = new Float32Array(ost.length).fill(NaN);
  for (let von = 0; von < ost.length; von += 2500) {
    const coords = [];
    for (let i = von; i < Math.min(ost.length, von + 2500); i++) coords.push([+ost[i].toFixed(2), +nord[i].toFixed(2)]);
    const r = await fetch(HOEHENDIENST, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srid: 25832, coords }) });
    if (!r.ok) throw new Error(`Höhendienst: HTTP ${r.status}`);
    (await r.json()).coords.forEach((c, j) => { if (c[2] !== null) aus[von + j] = c[2]; });
  }
  return aus;
}

/* ---- 1. UTM gegen proj4 ---- */
{
  let groesste = 0;
  for (const [lat, lon, e, n] of REFERENZ) {
    const [e2, n2] = H.utm32Hin(lat, lon);
    groesste = Math.max(groesste, Math.hypot(e2 - e, n2 - n));
  }
  pruefe(groesste < 0.001, `UTM gegen proj4: größte Abweichung ${zahl(groesste * 1000, 3)} mm an ${REFERENZ.length} Punkten`);
}

/* ---- 2. Rundlauf ---- */
{
  let groesste = 0, n = 0;
  for (let lat = 47.2; lat <= 50.65; lat += 0.05) {
    for (let lon = 8.9; lon <= 13.9; lon += 0.05) {
      const [e, no] = H.utm32Hin(lat, lon);
      const [la, lo] = H.utm32Zurueck(e, no);
      const [e2, n2] = H.utm32Hin(la, lo);
      groesste = Math.max(groesste, Math.hypot(e2 - e, n2 - no));
      n++;
    }
  }
  pruefe(groesste < 0.001, `Rundlauf geografisch ↔ UTM: größte Abweichung ${zahl(groesste * 1000, 4)} mm an ${n} Punkten`);
}

/** Die ersten Zeilen der XYZ-Fassung einer DGM1-Kachel, aus den ersten 64 kB
 *  der ZIP-Datei — der Rest des Archivs wird nicht gebraucht. */
async function xyzAnfang(ke, kn) {
  const r = await fetch(`https://download1.bayernwolke.de/a/dgm/dgm1xyz/${ke}_${kn}.zip`, { headers: { Range: 'bytes=0-65535' } });
  const b = Buffer.from(await r.arrayBuffer());
  if (b.readUInt32LE(0) !== 0x04034b50 || b.readUInt16LE(8) !== 8) throw new Error('XYZ: unerwarteter ZIP-Aufbau');
  const daten = b.subarray(30 + b.readUInt16LE(26) + b.readUInt16LE(28));
  const text = zlib.inflateRawSync(daten, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
  const zeilen = text.split(/\r?\n/);
  zeilen.pop();                                   // die letzte ist abgeschnitten
  return zeilen.map(z => z.trim().split(/\s+/).map(Number)).filter(z => z.length === 3);
}

/* ---- 3. DGM1 gegen die XYZ-Fassung ---- */
for (const [name, ke, kn] of [['Bamberg', 636, 5528], ['Berchtesgaden', 778, 5292]]) {
  const xyz = (await xyzAnfang(ke, kn)).slice(0, 4000);
  const ost = Float64Array.from(xyz, z => z[0]), nord = Float64Array.from(xyz, z => z[1]);
  const nn = await H.hoehenWerte('dgm1', ost, nord, 'nachbar');
  const bl = await H.hoehenWerte('dgm1', ost, nord);
  let groesste = 0, fehlt = 0;
  xyz.forEach((z, i) => {
    if (!Number.isFinite(nn[i]) || !Number.isFinite(bl[i])) { fehlt++; return; }
    groesste = Math.max(groesste, Math.abs(nn[i] - z[2]), Math.abs(bl[i] - z[2]));
  });
  pruefe(!fehlt && groesste < 0.006,
    `DGM1 ${name} gegen XYZ: ${xyz.length} Werte, ${fehlt} ohne Wert, größte Abweichung ${zahl(groesste * 100, 2)} cm ` +
    `(nächster Nachbar und bilinear an der Pixelmitte)`);
}

/* ---- 4. DGM1 gegen den Höhendienst ---- */
for (const [name, ke, kn] of [['Bamberg', 636, 5528], ['Berchtesgaden', 778, 5292]]) {
  const r = zufall(ke * 7919 + kn);
  const ost = [], nord = [];
  while (ost.length < 400) {
    const x = ke * 1000 + 2 + r() * 996, y = kn * 1000 + 2 + r() * 996;
    const fx = x % 0.5, fy = y % 0.5;
    if (Math.min(fx, 0.5 - fx) < 0.1 || Math.min(fy, 0.5 - fy) < 0.1) continue;
    ost.push(x); nord.push(y);
  }
  const t0 = performance.now();
  const ohne = await H.hoehenWerte('dgm1', Float64Array.from(ost), Float64Array.from(nord), 'nachbar');
  const dauer = performance.now() - t0;
  // Was der Dienst an (x, y) meldet, steht im Raster bei (x + 0,5, y − 0,5)
  const mit = await H.hoehenWerte('dgm1', Float64Array.from(ost, x => x + 0.5), Float64Array.from(nord, y => y - 0.5), 'nachbar');
  const ihre = await hoehendienst(ost, nord);

  /* Das DGM speichert Zentimeter, der Dienst rundet auf Dezimeter: Aus
   * demselben Pixel liegen beide also höchstens 5 cm auseinander. */
  const vergleich = werte => {
    let gleich = 0, fehlt = 0, groesste = 0;
    for (let i = 0; i < ost.length; i++) {
      if (!Number.isFinite(werte[i]) || !Number.isFinite(ihre[i])) { fehlt++; continue; }
      const d = Math.abs(werte[i] - ihre[i]);
      if (d <= 0.05 + 1e-4) gleich++;
      groesste = Math.max(groesste, d);
    }
    return { gleich, fehlt, groesste };
  };
  const a = vergleich(mit), b = vergleich(ohne);
  pruefe(a.gleich === ost.length,
    `DGM1 ${name} gegen Höhendienst (um ½ m versetzt): ${a.gleich} von ${ost.length} aus demselben Pixel, ` +
    `${a.fehlt} ohne Wert, größte Abweichung ${zahl(a.groesste)} m (${zahl(dauer, 0)} ms samt Laden) — ` +
    `ohne Versatz ${b.gleich} gleich, größte ${zahl(b.groesste)} m`);
}

/* ---- 5. Über die Kachelgrenze 636/637 ---- */
{
  const ost = [], nord = [];
  for (let x = 636980.3; x <= 637020.3; x += 0.25) { ost.push(x); nord.push(5528500.3); }
  const z = await H.hoehenWerte('dgm1', Float64Array.from(ost), Float64Array.from(nord));
  let sprung = 0;
  for (let i = 1; i < z.length; i++) sprung = Math.max(sprung, Math.abs(z[i] - z[i - 1]));
  pruefe(z.every(Number.isFinite) && sprung < 0.3,
    `Kachelgrenze: ${z.length} Werte über 40 m, alle vorhanden, größter Schritt ${zahl(sprung, 3)} m je 0,25 m`);
}

/* ---- 6. DOM20 ---- */
{
  // 300 m quer durch die Kachel 638_5526 (Bamberg), als Linienzug wie aus der App
  const a = H.utm32Zurueck(638150, 5526250), b = H.utm32Zurueck(638440, 5526330);
  const vorher = H.HOEHEN.geladen;
  let t0 = performance.now();
  const dgm = await H.hoehenProfil([a, b], 'dgm1');
  const tDgm = performance.now() - t0, mbDgm = (H.HOEHEN.geladen - vorher) / 2 ** 20;

  t0 = performance.now();
  const dom = await H.hoehenProfil([a, b], 'dom20');
  const tDom = performance.now() - t0;

  // DGM an den Stützpunkten des DOM, damit beide auf derselben Station stehen
  const dgmFein = await H.hoehenWerte('dgm1', dom.ost, dom.nord);
  const diff = Array.from(dom.hoehe, (z, i) => z - dgmFein[i]);
  const vorhanden = dom.hoehe.filter(Number.isFinite).length / dom.hoehe.length;
  let maxI = 0;
  diff.forEach((d, i) => { if (d > diff[maxI]) maxI = i; });

  console.log(`        DGM-Profil: ${dgm.station.length} Punkte, ${zahl(dgm.laenge, 1)} m, ${zahl(tDgm, 0)} ms, ${zahl(mbDgm)} MB`);
  console.log(`        DOM-Profil: ${dom.station.length} Punkte, ${zahl(tDom, 0)} ms, ${zahl(dom.geladen / 2 ** 20)} MB`);
  console.log(`        DOM − DGM: 5 % ${zahl(quantil(diff, 0.05))} m · Median ${zahl(quantil(diff, 0.5))} m · ` +
    `95 % ${zahl(quantil(diff, 0.95))} m · höchstens ${zahl(diff[maxI])} m bei Station ${zahl(dom.station[maxI], 1)} m`);
  pruefe(vorhanden > 0.99, `DOM20: ${zahl(vorhanden * 100, 1)} % der Stützpunkte mit Wert`);
  pruefe(quantil(diff, 0.05) > -0.5, 'DOM20 liegt nicht unter dem Gelände (5-%-Wert über −0,5 m) — Lage und Höhenbezug passen');
}

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden.');
process.exitCode = fehler ? 1 : 0;
