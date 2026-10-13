// Prüft infrago.js gegen die aufbereiteten Daten in infrago/:
//   node werkzeug/infrago-pruefen.mjs [vergleich.json]
// 1. Rundlauf km → Lage → km auf allen Strecken, je Abschnitt drei Kilometer.
// 2. Bahnübergänge (werkzeug/infrago-probe.json): Der km des Übergangs, auf der
//    Linie abgetragen, gegen die Lage, die InfraGO selbst für ihn angibt.
// 3. Ränder: unbekannte Strecke, Kilometer außerhalb, Unsinn.
// 4. Betriebsstellensuche.
// 5. Optional eine zweite, unabhängige Rechnung (Python, aus dem GeoPackage):
//    [[lat, lon, km Stein, Abweichung in m, Strecke], …] — der InfraGO-km an
//    der Steinstelle ist km Stein − Abweichung.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..');
let fehler = 0;
const ok = (bed, text) => { console.log((bed ? 'ok    ' : 'FEHLER') + '  ' + text); if (!bed) fehler++; };

const kontext = {
  module: { exports: {} },
  fetch: async url => {
    const datei = path.join(WURZEL, url);
    if (!fs.existsSync(datei)) return { ok: false, status: 404 };
    const text = fs.readFileSync(datei, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  },
  console, Math, JSON, Map, Set, Promise, String, Number, Object, Array, isFinite
};
vm.createContext(kontext);
vm.runInContext(fs.readFileSync(path.join(WURZEL, 'infrago.js'), 'utf8'), kontext);
const I = kontext.module.exports;

const quantil = (w, p) => { const s = [...w].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const m = x => x.toFixed(x < 10 ? 2 : 0) + ' m';

// Dekodierer gegen einen bekannten Wert (Polyline-Beispiel von Google, Faktor 1e5 → hier 1e6 gelesen)
const bsp = I.ifgDekodieren('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
ok(Math.abs(bsp[0].lat * 10 - 38.5) < 1e-9 && Math.abs(bsp[2].lon * 10 - -126.453) < 1e-9,
  `Polyline gelesen: ${bsp.map(p => (p.lat * 10).toFixed(3) + ',' + (p.lon * 10).toFixed(3)).join(' ')}`);

// ---------------------------------------------------------------- 1. Rundlauf
const ix = await I.ifgBereit();
ok(ix && ix.strecken.size > 1500, `Index: ${ix.strecken.size} Strecken, ${ix.kacheln.size} Kacheln`);

let zufall = 12345;
const rnd = () => (zufall = (zufall * 1103515245 + 12345) % 2147483648) / 2147483648;
const abw = [], fremd = [], doppelt = [];
let faelle = 0, ohne = 0;
for (const nr of [...ix.strecken].sort()) {
  const st = await I.ifgStrecke(nr);
  for (const g of st.abschnitte) {
    if (g.ri === 2 || g.hi - g.lo < 0.002) continue;
    for (let k = 0; k < 3; k++) {
      const km = g.lo + 0.001 + rnd() * (g.hi - g.lo - 0.002);
      const l = await I.ifgLage(nr, km);
      if (!l) { ohne++; continue; }
      faelle++;
      if (l.weitere.length) { doppelt.push([nr, km]); continue; }
      const r = await I.ifgKmAn(l.lat, l.lon, 5, [nr], 10);
      if (!r || r.ref !== nr) { fremd.push([nr, km, r && r.ref]); continue; }
      abw.push(Math.abs(r.punkt.km - km) * 1000);
    }
  }
}
console.log(`        ${faelle} Kilometer gerechnet, ${doppelt.length} kommen auf ihrer Strecke zweimal vor, ` +
  `${fremd.length} landen zurück auf einer anderen Strecke`);
ok(ohne === 0, `jeder Kilometer innerhalb eines Abschnitts hat eine Lage (${ohne} ohne)`);
ok(quantil(abw, 1) < 0.01, `Rundlauf km → Lage → km: schlechtester Fall ${quantil(abw, 1).toFixed(4)} m`);
ok(fremd.length / faelle < 0.01, `zurück auf derselben Strecke in ${((1 - fremd.length / faelle) * 100).toFixed(2)} %` +
  (fremd.length ? ` — z. B. ${fremd.slice(0, 3).map(f => f[0] + ' km ' + f[1].toFixed(3) + ' → ' + f[2]).join(', ')}` : ''));

// ---------------------------------------------------------------- 2. Bahnübergänge
const probe = JSON.parse(fs.readFileSync(path.join(HIER, 'infrago-probe.json'), 'utf8'));
const hin = [], zurueck = [];
let ohneLage = 0;
for (const [nr, km, lat, lon] of probe) {
  const l = await I.ifgLage(nr, km);
  if (!l) { ohneLage++; continue; }
  hin.push(I.ifgAbstand(l.lat, l.lon, lat, lon));
  const r = await I.ifgKmAn(lat, lon, 30, [nr], 30);
  if (r && r.ref === nr) zurueck.push(Math.abs(r.punkt.km - km) * 1000);
}
console.log(`        ${probe.length} Bahnübergänge, ${ohneLage} ohne Abschnitt bei ihrem km`);
ok(quantil(hin, 0.5) < 2 && quantil(hin, 0.9) < 6,
  `km des Übergangs auf der Linie gegen seinen eigenen Punkt: Median ${m(quantil(hin, 0.5))}, ` +
  `P90 ${m(quantil(hin, 0.9))}, P99 ${m(quantil(hin, 0.99))}`);
ok(quantil(zurueck, 0.5) < 2 && quantil(zurueck, 0.9) < 6,
  `Punkt des Übergangs → km, gegen seinen km: Median ${m(quantil(zurueck, 0.5))}, P90 ${m(quantil(zurueck, 0.9))} ` +
  `(${zurueck.length} Fälle)`);

// ---------------------------------------------------------------- 3. Ränder
ok(await I.ifgLage('99999', 1) === null, 'unbekannte Strecke → null');
ok(await I.ifgLage('abc', 1) === null && await I.ifgLage('', 1) === null, 'keine Nummer → null');
ok(await I.ifgLage('5100', 9999) === null, 'km außerhalb der Strecke → null');
ok(await I.ifgLage('5100', NaN) === null, 'km NaN → null');
const b5100 = I.ifgBereich(await I.ifgStrecke('5100'));
ok(b5100[0] < 1 && b5100[1] > 50, `Strecke 5100 von km ${b5100[0]} bis ${b5100[1]}`);
// Gegen die OSM-Steine km 12,0 (50.00109, 10.91353) und 13,1 (50.00948, 10.92162), geradlinig dazwischen
const p = await I.ifgLage('5100', 12.5);
const osm125 = [50.00109 + 0.5 / 1.1 * (50.00948 - 50.00109), 10.91353 + 0.5 / 1.1 * (10.92162 - 10.91353)];
ok(p && I.ifgAbstand(p.lat, p.lon, osm125[0], osm125[1]) < 30,
  `5100 km 12,5 bei ${p && p.lat.toFixed(5)}, ${p && p.lon.toFixed(5)} (${p && p.gleis}), ` +
  `${p && I.ifgAbstand(p.lat, p.lon, osm125[0], osm125[1]).toFixed(0)} m von der Sehne der OSM-Steine 12,0–13,1`);
ok(await I.ifgKmAn(49.0, 8.0, 50) === null || true, 'Punkt fern jeder Strecke ohne Absturz');
const fern = await I.ifgKmAn(54.9, 13.9, 50);   // Ostsee
ok(fern === null, 'Punkt auf der Ostsee → null');

// ---------------------------------------------------------------- 4. Betriebsstellen
const s1 = await I.ifgStellenSuchen('Bamberg');
ok(s1.length && s1[0].name === 'Bamberg' && s1[0].ds100 === 'NBA', `„Bamberg" → ${s1.map(s => s.name + ' ' + s.ds100).join(', ')}`);
const s2 = await I.ifgStellenSuchen('NN');
ok(s2.length && /Nürnberg Hbf/.test(s2[0].name), `DS100 „NN" → ${s2[0] && s2[0].name}`);
const s3 = await I.ifgStellenSuchen('breitengussbach');
ok(s3.length && /Breitengüßbach/.test(s3[0].name), `„breitengussbach" → ${s3[0] && s3[0].name}`);
const s4 = await I.ifgStellenSuchen('frankfurt hbf');
ok(s4.length && /Frankfurt \(Main\) Hbf/.test(s4[0].name), `„frankfurt hbf" → ${s4.slice(0, 3).map(s => s.name).join(', ')}`);
ok(s1[0].strecken.length >= 2, `Bamberg liegt an ${s1[0].strecken.map(x => x.nr + ' km ' + x.km).join(', ')}`);

// ---------------------------------------------------------------- 4b. Anlagen für die Auflage
const a5100 = await I.ifgAnlagen('5100');
ok(a5100 && a5100.bue.length > 20 && a5100.bruecken.length > 50,
  `Anlagen 5100: ${a5100.bue.length} Bahnübergänge, ${a5100.bruecken.length} Brücken, ${a5100.tunnel.length} Tunnel`);
/* Die Linie einer Brücke muss auf ihrer Strecke liegen, und der Kilometer dort
 * im Bereich der Brücke — sonst stimmt Linie oder Zuordnung nicht. */
const brAbw = [];
for (const nr of ['5100', '1733', '4000', '6100']) {
  const an = await I.ifgAnlagen(nr);
  for (const br of (an ? an.bruecken : []).slice(0, 60)) {
    const m = br.pts[Math.floor(br.pts.length / 2)];
    const r = await I.ifgKmAn(m.lat, m.lon, 30, [nr], Infinity);
    if (!r || r.ref !== nr) { brAbw.push(Infinity); continue; }
    const lo = Math.min(br.von, br.bis), hi = Math.max(br.von, br.bis);
    brAbw.push(Math.max(0, lo - r.punkt.km, r.punkt.km - hi) * 1000);
  }
}
ok(quantil(brAbw, 0.9) < 5, `Brückenmitte → km liegt im Bereich der Brücke: ${brAbw.filter(x => x < 5).length} von ${brAbw.length}` +
  ` (Median ${m(quantil(brAbw, 0.5))} daneben)`);
ok(await I.ifgAnlagen('99999') === null, 'Strecke ohne Anlagen-Datei → null');
const imRechteck = await I.ifgNummernImRechteck(49.95, 10.85, 50.05, 10.95);
ok(imRechteck && imRechteck.has('5100') && imRechteck.has('5919'), `um Zapfendorf liegen ${[...imRechteck].join(', ')}`);
ok(await I.ifgNummernImRechteck(47, 6, 55, 15) === null, 'ganz Deutschland auf einmal → null (zu viele)');

// ---------------------------------------------------------------- 5. Gegenrechnung
if (process.argv[2]) {
  const vgl = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  /* Die Python-Rechnung nahm den nächsten Abschnitt, dessen Kilometerbereich den
   * Stein enthält, gleich welches Gleis; hier gilt das Richtungsgleis vor dem
   * Gegengleis. Die beiden Gleise sind je für sich kilometriert und lesen sich
   * am selben Querschnitt meist auf Zentimeter gleich, in Bögen einige Meter
   * verschieden, an wenigen Stellen weit (siehe IFG_GLEIS_M). Wo Python das
   * Gegengleis nahm, steckt dieser Unterschied mit drin — gemessen bei 6 % der
   * Steine über 2 m. Geprüft wird deshalb der Median und der Anteil über 2 m. */
  const d = [], anders = [];
  for (let i = 0; i < vgl.length; i += 20) {
    const [lat, lon, km, diff, nr] = vgl[i];
    const r = await I.ifgKmAn(lat, lon, 30, [String(nr)], 30);
    if (!r || r.ref !== String(nr)) continue;
    const py = km - diff / 1000;
    const [a, b] = r.punkt.abschnitt;
    if (py < Math.min(a, b) - 0.005 || py > Math.max(a, b) + 0.005) { anders.push(r.punkt.gleis); continue; }
    d.push(Math.abs(r.punkt.km - py) * 1000);
  }
  ok(quantil(d, 0.5) < 0.3 && d.filter(x => x > 2).length < 0.1 * d.length,
    `gegen die Python-Rechnung an ${d.length} OSM-Steinen: Median ${m(quantil(d, 0.5))}, P95 ${m(quantil(d, 0.95))}, ` +
    `über 2 m ${d.filter(x => x > 2).length}; ${anders.length} Mal anderer Abschnitt`);
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles ok');
process.exit(fehler ? 1 : 0);
