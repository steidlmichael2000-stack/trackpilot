/* Baut bw-grenze.json: die Landesgrenze Baden-Württembergs, vereinfacht.
 *
 *   node werkzeug/bw-grenze-bauen.mjs
 *
 * Quelle: OGC API Features des LGL (Beta), Sammlung „bundesland" — ATKIS
 * Basis-DLM, Datenlizenz Deutschland – Namensnennung 2.0. Gebraucht wird die
 * Grenze nur, um je Kartenkachel zu entscheiden, wessen DOP20 sie zeigt
 * (app.js, dopKachel). Kacheln nahe der Grenze holen ohnehin beide Bilder und
 * legen sie übereinander; die Vereinfachung muss also nur deutlich feiner sein
 * als dieser Saum (DOP_SAUM_M in app.js).
 *
 * Vereinfacht nach Douglas-Peucker in UTM 32 mit TOLERANZ Metern, gespeichert
 * als [[lat, lon], …] je Ring, auf 5 Nachkommastellen (rund 1 m). */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const H = require('../hoehen.js');
const QUELLE = 'https://ogcapi.lgl-bw.de/beta/pygeoapi/collections/bundesland/items?f=json&limit=5';
const TOLERANZ = 50;   // m; mit 20 m wurden es 137 kB statt 79

function dp(punkte, tol) {
  if (punkte.length < 3) return punkte;
  const behalten = new Uint8Array(punkte.length);
  behalten[0] = behalten[punkte.length - 1] = 1;
  const stapel = [[0, punkte.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    const [ax, ay] = punkte[a], [bx, by] = punkte[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let weit = -1, wo = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = punkte[i];
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > weit) { weit = d; wo = i; }
    }
    if (weit > tol) { behalten[wo] = 1; stapel.push([a, wo], [wo, b]); }
  }
  return punkte.filter((_, i) => behalten[i]);
}

const r = await fetch(QUELLE, { headers: { Accept: 'application/geo+json' } });
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const fc = await r.json();
const bw = fc.features.find(f => /W.rttemberg/.test(f.properties.bundesland_name));
if (!bw) throw new Error('Baden-Württemberg nicht in der Antwort');
const polys = bw.geometry.type === 'MultiPolygon' ? bw.geometry.coordinates : [bw.geometry.coordinates];

let vorher = 0, nachher = 0;
const ringe = [];
for (const poly of polys) for (const ring of poly) {
  const [lon0, lat0] = ring[0];
  if (Math.abs(lon0) > 180 || Math.abs(lat0) > 90) throw new Error('Koordinaten sind nicht geografisch');
  const utm = ring.map(([lon, lat]) => H.utm32Hin(lat, lon));
  const einfach = dp(utm, TOLERANZ);
  vorher += ring.length; nachher += einfach.length;
  if (einfach.length < 4) continue;
  ringe.push(einfach.map(([e, n]) => H.utm32Zurueck(e, n).map(x => Math.round(x * 1e5) / 1e5)));
}

const aus = { quelle: 'LGL-BW, ATKIS Basis-DLM über OGC API Features (Beta), dl-de/by-2-0',
  stand: new Date().toISOString().slice(0, 10), toleranz_m: TOLERANZ, ringe };
const ziel = new URL('../bw-grenze.json', import.meta.url);
fs.writeFileSync(ziel, JSON.stringify(aus));
console.log(`${polys.length} Polygon(e), ${ringe.length} Ringe, ${vorher} → ${nachher} Punkte, ` +
  `${(fs.statSync(ziel).size / 1024).toFixed(1)} kB → bw-grenze.json`);
