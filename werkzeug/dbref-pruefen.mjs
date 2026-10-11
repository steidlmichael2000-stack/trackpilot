/* Prüft die Umrechnung ETRS89 → DB_REF Gauß-Krüger (dbrefGk in app.js).
 *
 * Die Referenzwerte wurden einmalig mit proj4 2.6.2 gerechnet:
 *   von  +proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0
 *   nach EPSG:5683 bzw. 5684 (DB_REF / 3-degree Gauss-Kruger zone 3 bzw. 4) mit
 *        +towgs84=584.9636,107.7175,413.8067,1.1155214628,0.2824339890,-3.1384490633,7.992235
 * Das ist EPSG:5826 „DB_REF to ETRS89 (1)" in der Schreibweise von proj (Position Vector).
 *
 * Aufruf: node werkzeug/dbref-pruefen.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const stueck = src.slice(src.indexOf('const DBREF = {'), src.indexOf('/* Die Streifengrenze'));
const { dbrefGk } = new Function(stueck + '; return { dbrefGk };')();

// [lat, lon, Streifen, Rechts, Hoch]
const REFERENZ = [
  [49.66417, 10.05845, 3, 3576487.882, 5503592.619],
  [49.66417, 10.05845, 4, 4359942.384, 5504861.550],
  [47.5, 10.2, 3, 3590488.546, 5263093.495],
  [50.4, 9.6, 3, 3542733.587, 5585072.532],
  [48.1, 11.6, 4, 4470315.123, 5329181.897],
  [49.45, 11.08, 4, 4433397.293, 5479638.427],
  [47.6, 12.98, 4, 4573804.024, 5273976.990],
  [50.3, 12.1, 4, 4507230.446, 5573779.456],
  [49.0, 10.5, 3, 3609831.479, 5430272.810],
  [49.0, 10.5, 4, 4390350.785, 5430269.208],
];

let groesste = 0;
for (const [lat, lon, s, r, h] of REFERENZ) {
  const [rr, hh] = dbrefGk(lat, lon, s);
  groesste = Math.max(groesste, Math.hypot(rr - r, hh - h));
}
const ok = groesste < 0.002;
console.log(`${ok ? 'ok    ' : 'FEHLER'}  DB_REF GK3/GK4 gegen proj4: größte Abweichung ${(groesste * 1000).toFixed(1)} mm an ${REFERENZ.length} Punkten`);
process.exit(ok ? 0 : 1);
