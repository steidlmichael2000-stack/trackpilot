/* Prüft gebaeude.js gegen die Oberfläche — unter Node, wo kein CORS gilt.
 *
 *   node werkzeug/gebaeude-pruefen.mjs
 *
 * Je Land (Bayern: Bamberg 636_5524 gegen DOM20; Baden-Württemberg: Stuttgart
 * 513_5403 gegen DOM1):
 * 1. Eine LoD2-Kachel Stück für Stück lesen: Anzahl, Dauer
 * 2. Schnitte quer durch 40 zufällige Gebäude: Dachhöhe aus LoD2 gegen die
 *    Oberfläche an denselben Stellen, mitten im Gebäude (1 m vom Rand weg, wo
 *    das DOM die Kante verschmiert). Zwei unabhängige Modelle — LoD2 aus
 *    Grundriss und Laserpunkten generalisiert, DOM aus Befliegung.
 * 3. Die Gebäudehöhe aus LoD2 (measuredHeight) gegen First minus Boden — nur
 *    Bayern, in BW fehlt HoeheGrund. */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../hoehen.js');
Object.assign(globalThis, H, {
  BVV_DOWNLOAD: 'https://download1.bayernwolke.de/a',
  vorratLesen: async () => null, vorratSchreiben: () => {}
});
H.HOEHEN.direkt = true;
const G = require('../gebaeude.js');

let fehler = 0;
const pruefe = (ok, text) => { console.log(`${ok ? 'ok    ' : 'FEHLER'}  ${text}`); if (!ok) fehler++; };
const zahl = (x, st = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: st, maximumFractionDigits: st });
const quantil = (w, q) => { const s = [...w].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

for (const [name, ke, kn, land, domName] of [['Bamberg', 636, 5524, 'by', 'DOM20'], ['Stuttgart', 513, 5403, 'bw', 'DOM1']]) {
  let t0 = performance.now();
  const liste = await G.gebaeudeKachel(ke, kn, land);
  const dauer = performance.now() - t0;
  const mitAdresse = liste.filter(b => b.adr).length, flaechen = liste.reduce((s, b) => s + b.d.length, 0);
  const kompakt = JSON.stringify(liste).length / 2 ** 20;
  pruefe(liste.length > 300 && mitAdresse > 50, `${name} ${ke}_${kn}: ${liste.length} Gebäude, ${flaechen} Dachflächen, ${mitAdresse} mit Adresse, ` +
    `gelesen in ${zahl(dauer / 1000, 1)} s, behalten ${zahl(kompakt, 1)} MB`);

  // Fester Zufall: jeder Lauf dieselben Gebäude
  let saat = 4711;
  const zufall = () => { saat = (saat * 1103515245 + 12345) % 2147483648; return saat / 2147483648; };
  const kandidaten = liste.filter(b => (b.bb[2] - b.bb[0]) > 8 && (b.bb[3] - b.bb[1]) > 8 && b.h > 3);
  const abw = [], hoehen = [], domLaender = new Set();
  let schnitte = 0;
  for (let k = 0; k < 40; k++) {
    const b = kandidaten[Math.floor(zufall() * kandidaten.length)];
    const ce = (b.bb[0] + b.bb[2]) / 2, cn = (b.bb[1] + b.bb[3]) / 2, w = zufall() * Math.PI;
    const a = H.utm32Zurueck(ce - 40 * Math.cos(w), cn - 40 * Math.sin(w));
    const z = H.utm32Zurueck(ce + 40 * Math.cos(w), cn + 40 * Math.sin(w));
    const dgm = await H.hoehenProfil([a, z], 'dgm1');
    const geb = await G.gebaeudeImSchnitt([a, z], dgm);
    const dies = geb.find(x => x.id === b.id);
    if (!dies) continue;
    schnitte++;
    const dom = await H.hoehenProfil([a, z], 'dom20', { maxPunkte: 2000 });
    dom.quellen.forEach(l => domLaender.add(l));
    /* In der Mitte jeder Dachfläche — nicht an First und Graten, die das DOM
     * abrundet */
    for (let j = 0; j + 1 < dies.dach.length; j += 2) {
      const [sa, za] = dies.dach[j], [sb, zb] = dies.dach[j + 1];
      if (sb - sa < 1) continue;
      const s = (sa + sb) / 2, zl = (za + zb) / 2;
      if (s < dies.s0 + 1 || s > dies.s1 - 1) continue;
      let i = 0;
      while (i < dom.station.length - 1 && dom.station[i] < s) i++;
      if (Number.isFinite(dom.hoehe[i])) abw.push(dom.hoehe[i] - zl);
    }
    if (b.h && b.gr) hoehen.push(Math.abs(dies.first - b.gr - b.h));
  }
  const absAbw = abw.map(Math.abs);
  pruefe(schnitte >= 35, `${name}: ${schnitte} von 40 Schnitten treffen ihr Gebäude`);
  pruefe(quantil(absAbw, 0.5) < 0.5 && [...domLaender].join() === land,
    `${name}: Dach LoD2 gegen ${domName} an ${abw.length} Stellen: Median |Δ| ${zahl(quantil(absAbw, 0.5))} m, 90 % ${zahl(quantil(absAbw, 0.9))} m, ` +
    `Median Δ ${zahl(quantil(abw, 0.5))} m (DOM − LoD2)`);
  if (land === 'by') pruefe(quantil(hoehen, 0.9) < 0.5, `${name}: First − Boden gegen measuredHeight: 90 % innerhalb ${zahl(quantil(hoehen, 0.9))} m`);
  console.log(`        Beispiel: ${(() => { const b = liste.find(x => x.adr); return b ? `${G.gebFunktion(b.fn)}, ${G.gebDach(b.dach)}, ${b.h} m, ${b.adr}` : '–'; })()}`);
}
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden.');
process.exitCode = fehler ? 1 : 0;
