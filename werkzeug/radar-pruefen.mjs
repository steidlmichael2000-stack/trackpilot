// Prüft radar-werk.js gegen den Dienst des DWD:
//   node werkzeug/radar-pruefen.mjs
// 1. Ein GeoTIFF lesen und mit GetFeatureInfo des WMS an derselben Stelle vergleichen.
// 2. Ein Bild um eine bekannte Strecke verschieben — die Schätzung muss sie finden.
// 3. Zwei echte Bilder: Mit der geschätzten Bewegung muss das Zwischenbild näher an
//    beiden liegen als bloßes Überblenden.
import { tiffLesen, flussRechnen } from '../radar-werk.js';

const WCS = 'https://maps.dwd.de/geoserver/dwd/ows';
const CRS = 'http://www.opengis.net/def/crs/EPSG/0/3857';
let fehler = 0;
const ok = (bed, text) => { console.log((bed ? 'ok    ' : 'FEHLER') + '  ' + text); if (!bed) fehler++; };

async function referenz() {
  const r = await fetch('https://maps.dwd.de/geoserver/dwd/Niederschlagsradar/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0');
  const m = /name="REFERENCE_TIME"[^>]*default="([^"]+)"/.exec(await r.text());
  return Date.parse(m[1]);
}

async function bild(t, [x0, y0, x1, y1]) {
  const iso = new Date(t).toISOString().replace('.000Z', 'Z');
  const url = `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=dwd__Niederschlagsradar` +
    `&format=image/tiff&geotiff:compression=Deflate&subsettingCrs=${CRS}&outputCrs=${CRS}` +
    `&subset=X(${x0},${x1})&subset=Y(${y0},${y1})&subset=time("${iso}")`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return tiffLesen(await r.arrayBuffer());
}

// Wo regnet es gerade? Ganz Deutschland verkleinert holen und die nasseste Gegend nehmen.
const ref = await referenz();
console.log('letzte Messung', new Date(ref).toISOString());
const D = [500000, 5900000, 1700000, 7400000];
const grob = await bild(ref, D);
let best = -1, bx = 0, by = 0;
const B = 40;
for (let y = 0; y + B <= grob.h; y += B / 2) for (let x = 0; x + B <= grob.w; x += B / 2) {
  let s = 0;
  for (let j = y; j < y + B; j++) for (let i = x; i < x + B; i++) s += grob.werte[j * grob.w + i] > 0 ? 1 : 0;
  if (s > best) { best = s; bx = x; by = y; }
}
const mx = grob.x0 + (bx + B / 2) * grob.dx, my = grob.yOben - (by + B / 2) * grob.dy;
const halb = 150000;
const bereich = [Math.round(mx - halb), Math.round(my - halb), Math.round(mx + halb), Math.round(my + halb)];
console.log('Ausschnitt um', Math.round(mx), Math.round(my), `(${best} nasse Zellen im Suchfeld)`);

// 1. Wert gegen GetFeatureInfo
const a = await bild(ref - 5 * 60000, bereich);
// Die Zelle wächst nach Norden: 1464 m bei Stuttgart, 1733 m an der Küste (Mercator-Meter)
ok(a.w > 100 && a.h > 100 && a.dx > 1300 && a.dx < 2000,`Raster ${a.w} × ${a.h}, Zelle ${a.dx.toFixed(0)} × ${a.dy.toFixed(0)} m`);
let gi = 0;
for (let k = 0; k < a.werte.length; k++) if (a.werte[k] > a.werte[gi]) gi = k;
if (a.werte[gi] > 0) {
  const px = a.x0 + ((gi % a.w) + 0.5) * a.dx, py = a.yOben - (Math.floor(gi / a.w) + 0.5) * a.dy;
  const d = 300;
  const fi = await (await fetch(`https://maps.dwd.de/geoserver/dwd/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
    `&LAYERS=Niederschlagsradar&QUERY_LAYERS=Niederschlagsradar&CRS=EPSG:3857&BBOX=${px - d},${py - d},${px + d},${py + d}` +
    `&WIDTH=3&HEIGHT=3&I=1&J=1&INFO_FORMAT=application/json&TIME=${new Date(ref - 5 * 60000).toISOString().replace('.000Z', 'Z')}`)).json();
  const soll = fi.features[0].properties.RV_ANALYSIS;
  ok(Math.abs(soll - a.werte[gi]) < 0.011, `Höchstwert ${a.werte[gi].toFixed(3)} mm/5 min, WMS an derselben Stelle ${soll.toFixed(3)}`);
} else {
  console.log('—       im Ausschnitt kein Regen, Wertevergleich übersprungen');
}

// 2. Bekannte Verschiebung
const [sx, sy] = [4, -3];
const versch = new Float32Array(a.werte.length);
for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
  const qx = x - sx, qy = y - sy;
  versch[y * a.w + x] = qx < 0 || qy < 0 || qx >= a.w || qy >= a.h ? 0 : a.werte[qy * a.w + qx];
}
let t0 = performance.now();
const f = flussRechnen(a.werte, versch, a.w, a.h, a.dx);
const ms = performance.now() - t0;
const xs = [], ys = [];
for (let k = 0; k < f.fw * f.fh; k++) { xs.push(f.fluss[2 * k]); ys.push(f.fluss[2 * k + 1]); }
const median = v => v.slice().sort((p, q) => p - q)[v.length >> 1];
ok(Math.abs(median(xs) - sx) < 0.5 && Math.abs(median(ys) - sy) < 0.5,
  `Verschiebung (${sx}, ${sy}) gefunden als (${median(xs).toFixed(2)}, ${median(ys).toFixed(2)}), ${ms.toFixed(0)} ms`);

// 3. Echtes Paar: Zwischenbild aus Bewegung gegen bloßes Überblenden
const b = await bild(ref, bereich);
t0 = performance.now();
const g = flussRechnen(a.werte, b.werte, a.w, a.h, a.dx);
const ms2 = performance.now() - t0;
const probe = (werte, x, y) => {
  if (x < 0 || y < 0 || x > a.w - 1 || y > a.h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const v = (i, j) => werte[Math.min(a.h - 1, j) * a.w + Math.min(a.w - 1, i)];
  return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
};
const flussBei = (x, y) => {
  const u = Math.max(0, Math.min(g.fw - 1, (x + 0.5) / g.s - 0.5)), w = Math.max(0, Math.min(g.fh - 1, (y + 0.5) / g.s - 0.5));
  const i = Math.round(u), j = Math.round(w), k = j * g.fw + i;
  return [g.fluss[2 * k], g.fluss[2 * k + 1]];
};
// Mit der Bewegung muss A, um den ganzen Weg geschoben, B ähnlicher sein als A selbst
let ohne = 0, mit = 0;
for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
  const [vx, vy] = flussBei(x, y);
  const soll = b.werte[y * a.w + x];
  ohne += Math.abs(a.werte[y * a.w + x] - soll);
  mit += Math.abs(probe(a.werte, x - vx, y - vy) - soll);
}
const [mvx, mvy] = [median(Array.from({ length: g.fw * g.fh }, (_, k) => g.fluss[2 * k])),
  median(Array.from({ length: g.fw * g.fh }, (_, k) => g.fluss[2 * k + 1]))];
console.log(`        Zug im Mittel (${mvx.toFixed(2)}, ${mvy.toFixed(2)}) Zellen je 5 min, ` +
  `rund ${(Math.hypot(mvx, mvy) * a.dx * Math.cos(Math.atan(Math.sinh(my / 6378137))) / 1000 * 12).toFixed(0)} km/h`);
ok(mit <= ohne * 1.001, `Abweichung zu B: verschoben ${mit.toFixed(1)}, unverschoben ${ohne.toFixed(1)} (${ms2.toFixed(0)} ms)`);

console.log(fehler ? `\n${fehler} Fehler` : '\nalles ok');
process.exit(fehler ? 1 : 0);
