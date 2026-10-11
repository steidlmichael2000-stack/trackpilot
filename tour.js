/* TrackPilot — Tour durch die App
 *
 * Das „?" im ©-Kasten unten links startet sie; beim allerersten Start bietet die
 * App sie einmal an (prefs.tourAngeboten). Neun Schritte: Die Ebene #tour dunkelt
 * alles ab bis auf ein „Loch" über dem gerade erklärten Element, daneben steht
 * eine Blase mit Text, Weiter und Zurück. Am Rechner gehen auch die Pfeiltasten;
 * Escape beendet.
 *
 * Die Tour führt live vor, was sie erklärt: Sie tippt eine Strecke ein und sucht,
 * setzt einen Punkt, öffnet Messmenü und Einstellungen und zeichnet ein Profil.
 * Dafür ruft sie dieselben Funktionen auf wie die Knöpfe — search, merkPunkt,
 * messMenueAuf, profStart, openSheet und so weiter, alle aus app.js. Wer dort
 * etwas umbenennt, zieht es hier nach. Klappt eine Vorführung nicht (ohne Netz,
 * außerhalb Bayerns), sagt die Blase das, statt zu hängen.
 *
 * Während der Tour nimmt die Ebene alle Griffe ab: Die Karte bewegt sich nur
 * durch die Vorführung, und ein versehentlicher Tipp bringt nichts durcheinander.
 */

const TOUR_TIPPEN_MS = 85;          // je Zeichen beim Vorführen der Eingabe
const TOUR_GEDULD_MS = 12000;       // so lange wartet eine Vorführung höchstens aufs Netz
const TOUR_BEISPIEL = '5100 12,5';  // Strecke Bamberg–Hof bei Breitengüßbach: in Bayern, mit Steinen

let tourIndex = -1;
let tourLauf = 0;                   // jeder Schritt bekommt eine Nummer; überholte Vorführungen brechen ab

const tourWarte = ms => new Promise(r => setTimeout(r, ms));

/** Wartet, bis bedingung() wahr ist — oder die Geduld aus ist. */
async function tourBis(bedingung, ms = TOUR_GEDULD_MS) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return true;
    await tourWarte(100);
  }
  return bedingung();
}

/** Das Element, wenn es zu sehen ist; sonst null — dann gibt es kein Loch. */
function tourSichtbar(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  return el && !el.hidden && el.getClientRects().length ? el : null;
}

/* Tippt den Text Zeichen für Zeichen in die Suchzeile — ohne sie zu fokussieren:
 * Auf dem Handy klappte sonst mitten in der Tour die Tastatur auf. Das
 * input-Ereignis lässt die Felder Strecke und Kilometer mitlaufen wie beim
 * Tippen von Hand. */
async function tourTippen(text, lauf) {
  const q = $('#q');
  suchAuf();
  q.value = '';
  for (const zeichen of text) {
    if (lauf !== tourLauf) return;
    q.value += zeichen;
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await tourWarte(TOUR_TIPPEN_MS);
  }
  closeSuggest();
}

function tourAbschnitt(name) {
  openSheet();
  document.querySelectorAll('#sheet [data-sec]').forEach(s => { s.open = s.dataset.sec === name; });
  $('#sheet').scrollTop = 0;
}

/* Die Schritte. ziel() liefert das Element fürs Loch, vorher() führt vor und
 * darf einen Text zurückgeben, der den regulären ersetzt (wenn es nicht
 * geklappt hat), nachher() räumt auf, bevor der nächste Schritt beginnt. */
const TOUR_SCHRITTE = [
  {
    titel: 'Eine Zeile für alles',
    text: `Ort, Bahnhof, Strecke mit Kilometer oder eine Koordinate — alles kommt hier hinein. ` +
      `Zum Ausprobieren tippe ich „${TOUR_BEISPIEL}" ein: Strecke 5100, Kilometer 12,5.`,
    ziel: () => $('.bar-top'),
    vorher: lauf => tourTippen(TOUR_BEISPIEL, lauf)
  },
  {
    titel: 'Das Ergebnis',
    text: 'Unten steht, wo der Kilometer liegt — mit der Genauigkeit, der Geländehöhe, dem Weg zu ' +
      'Google Maps und zum Teilen. Der orange Knopf zeichnet das Profil am Gleis. Die Kilometersteine ' +
      'der Strecke stehen beschriftet auf der Karte.',
    ziel: () => tourSichtbar('#bottom'),
    vorher: async lauf => {
      if ($('#q').value.trim() !== TOUR_BEISPIEL) await tourTippen(TOUR_BEISPIEL, lauf);
      if (lauf !== tourLauf) return;
      try { await Promise.race([search(), tourWarte(TOUR_GEDULD_MS)]); } catch { /* unten bewertet */ }
      if (view.point && view.ref === '5100') return;
      return 'Gerade antwortet der Dienst für die Kilometersteine nicht — eine neue Strecke braucht ' +
        'Netz. Mit Netz steht hier unten, wo der Kilometer liegt, wie genau, und der Weg zu Google Maps.';
    }
  },
  {
    titel: 'Lange drücken setzt einen Punkt',
    text: 'Lange auf die Karte drücken (am Rechner: Rechtsklick) setzt einen Punkt — mit Koordinate, ' +
      'Google Maps und „Kilometer bestimmen". Ein kurzer Tipp tut absichtlich nichts: Im Gelände tippt ' +
      'man oft aus Versehen.',
    ziel: () => tourSichtbar('.leaflet-popup'),
    vorher: async () => {
      const c = map.getCenter();
      merkPunkt(c.lat, c.lng);
      await tourWarte(350);          // die Karte schiebt die Blase notfalls ins Bild
    },
    nachher: () => map.closePopup()  // schließt die Blase und nimmt den Punkt mit
  },
  {
    titel: 'Wo stehe ich?',
    text: 'Der Standortknopf verfolgt die eigene Position. Ein Tipp auf den blauen Punkt lässt den ' +
      'Kilometer beim Gehen mitlaufen — ohne Netz, aus dem mitgelieferten Gleisnetz.',
    ziel: () => $('#mapLocBtn')
  },
  {
    titel: 'Messen und Profil',
    text: 'Der Messknopf öffnet drei Werkzeuge: Profil zeigt den Geländeschnitt zwischen Punkten, ' +
      'Polygon misst Strecken und — geschlossen — Flächen, Live die Entfernung vom Startpunkt zum ' +
      'Fadenkreuz.',
    ziel: () => tourSichtbar('#messMenue'),
    vorher: () => messMenueAuf(true),
    nachher: () => messMenueAuf(false)
  },
  {
    titel: 'Das Geländeprofil',
    text: 'Der Querschnitt am Gleis aus dem amtlichen Geländemodell, unüberhöht. Wischen über das Bild ' +
      'zeigt Höhe und Stelle auf der Karte. Der Regler stellt die Breite ein, die Knöpfe darunter ' +
      'springen meterweise die Strecke entlang, „Längs" zeigt den Verlauf am Gleis. Über den Messknopf ' +
      'geht das Profil auch frei zwischen getippten Punkten. „Gebäude" und „Oberfläche" legen ' +
      'Häuser und Bewuchs dazu. Nur in Bayern.',
    ziel: () => tourSichtbar('#bottom'),
    vorher: async lauf => {
      /* Am Gleis, wenn das Ergebnis aus Schritt 2 noch dasteht — sonst frei,
       * 300 m quer zur Blickrichtung durch die Kartenmitte */
      if (view.point && view.ref && view.km != null) {
        gpStart('quer');           // die Tour zeigt den Querschnitt, ohne die gemerkte Wahl zu ändern
      } else {
        const c = map.getCenter(), d = 150 / (111320 * Math.cos(c.lat * Math.PI / 180));
        profStart();
        profPunkte = [[c.lat, c.lng - d], [c.lat, c.lng + d]];
        profGeaendert();
      }
      await tourBis(() => lauf !== tourLauf || (!profLaedt && (profDgm || profFehler)));
      if (lauf === tourLauf && !profDgm) {
        return 'Hier kam kein Profil zustande — es braucht Netz und geht nur in Bayern. Sonst steht unten ' +
          'der Geländeschnitt am Gleis oder zwischen getippten Punkten, auf Wunsch mit Gebäuden und Bewuchs.';
      }
    },
    nachher: () => { if (profModus) profEnde(); }
  },
  {
    titel: 'Karten und Auflagen',
    text: 'Hinter dem Regler-Symbol: Karte, dunkle Karte, Luftbild, das amtliche Orthophoto DOP20 und ' +
      'das Geländerelief. Darüber lassen sich Bahn-Layer, Flurstücke, Straßen und Ortsnamen legen. ' +
      'Regenradar, Luftdruck und Temperatur stehen unter Wetter.',
    ziel: () => tourSichtbar('#sheet'),
    vorher: () => tourAbschnitt('karte'),
    nachher: () => closeSheet()
  },
  {
    titel: 'Eigene Dateien und Abstecken',
    text: 'KML- und KMZ-Dateien bleiben auf dem Gerät, auch ohne Netz. Haben sie Punkte, erscheint ' +
      'rechts ein Fähnchen: Punkt wählen, dann zeigen Pfeil und Entfernung den Weg dorthin.',
    ziel: () => tourSichtbar('#sheet [data-sec="kml"]'),
    vorher: () => tourAbschnitt('kml'),
    nachher: () => closeSheet()
  },
  {
    titel: 'Quellen und diese Tour',
    text: 'Hinter dem © stehen Quellen und Lizenzen. Das ? daneben startet diese Tour jederzeit ' +
      'wieder. Viel Erfolg im Gelände!',
    ziel: () => $('.quellen-kasten')
  }
];

/* ---- Ablauf ---- */

function tourStart() {
  tourAngebotZu();
  // Von einem ruhigen Ausgangspunkt aus: laufende Abläufe und Menüs zu
  if (messModus) messEnde();
  if (profModus) profEnde();
  messMenueAuf(false);
  closeSheet();
  map.closePopup();

  $('#tour').hidden = false;
  document.addEventListener('keydown', tourTaste);
  window.addEventListener('resize', tourLage);
  tourZeigen(0);
}

function tourEnde() {
  const s = TOUR_SCHRITTE[tourIndex];
  tourIndex = -1;
  tourLauf++;
  if (s && s.nachher) s.nachher();
  closeSuggest();
  $('#tour').hidden = true;
  document.removeEventListener('keydown', tourTaste);
  window.removeEventListener('resize', tourLage);
  $('#tourBtn').focus();
}

async function tourZeigen(i) {
  if (i < 0) return;
  if (i >= TOUR_SCHRITTE.length) { tourEnde(); return; }
  const alt = TOUR_SCHRITTE[tourIndex];
  if (alt && alt.nachher) alt.nachher();
  tourIndex = i;
  const lauf = ++tourLauf;
  const s = TOUR_SCHRITTE[i];

  $('#tourZahl').textContent = `${i + 1} / ${TOUR_SCHRITTE.length}`;
  $('#tourTitel').textContent = s.titel;
  $('#tourText').textContent = s.text;
  $('#tourZurueck').disabled = i === 0;
  $('#tourWeiter').textContent = i === TOUR_SCHRITTE.length - 1 ? 'Fertig' : 'Weiter';
  $('#tourPunkte').innerHTML = TOUR_SCHRITTE.map((_, j) => `<i${j === i ? ' class="is-on"' : ''}></i>`).join('');
  $('#tourWeiter').focus();
  $('#tour').classList.toggle('laeuft', !!s.vorher);
  tourLage();

  if (!s.vorher) return;
  /* Während der Vorführung erscheinen Ziele erst oder wachsen noch (die
   * Profil-Leiste, sobald das Diagramm steht): Loch und Blase laufen mit. */
  const nachfuehren = setInterval(tourLage, 250);
  let ersatz;
  try { ersatz = await s.vorher(lauf); } catch { /* dann bleibt der reguläre Text */ }
  clearInterval(nachfuehren);
  if (lauf !== tourLauf) return;
  $('#tour').classList.remove('laeuft');
  if (ersatz) $('#tourText').textContent = ersatz;
  tourLage();
}

function tourTaste(ev) {
  if (ev.key === 'Escape') { ev.preventDefault(); tourEnde(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); tourZeigen(tourIndex + 1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); tourZeigen(tourIndex - 1); }
}

/* Loch und Blase an das Ziel legen. Die Blase steht unter dem Ziel, wenn dort
 * Platz ist, sonst darüber, sonst daneben (am großen Bildschirm neben dem
 * offenen Menü); passt sie nirgends (das Menü füllt auf dem Handy fast den
 * Schirm), steht sie unten am Rand. */
function tourLage() {
  if (tourIndex < 0) return;
  const s = TOUR_SCHRITTE[tourIndex];
  const ziel = s.ziel && s.ziel();
  const loch = $('#tour .tour-loch'), blase = $('#tour .tour-blase');
  const W = window.innerWidth, H = window.innerHeight, rand = 10, abstand = 10, pad = 6;
  const bw = blase.offsetWidth, bh = blase.offsetHeight;

  let r = ziel && ziel.getBoundingClientRect();
  if (r && (r.width < 1 || r.height < 1)) r = null;

  if (!r) {
    /* Erscheint das Ziel erst durch die Vorführung (die Sprechblase eines
     * gesetzten Punkts), bleibt das Loch solange, wo es war — statt erst auf die
     * Bildmitte zu schrumpfen und gleich wieder aufzugehen. */
    if ($('#tour').classList.contains('laeuft') && loch.style.width) return;
    loch.classList.add('leer');
    Object.assign(loch.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px' });
    blase.style.left = Math.round((W - bw) / 2) + 'px';
    blase.style.top = Math.round((H - bh) / 2) + 'px';
    return;
  }

  loch.classList.remove('leer');
  const kreis = getComputedStyle(ziel).borderRadius.includes('50%');
  loch.classList.toggle('kreis', kreis);
  Object.assign(loch.style, {
    left: r.left - pad + 'px', top: r.top - pad + 'px',
    width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px'
  });

  let top, links = r.left + r.width / 2 - bw / 2;
  const seitlich = r.top - pad;                        // neben dem Ziel: oben bündig
  if (H - (r.bottom + pad) >= bh + abstand + rand) top = r.bottom + pad + abstand;
  else if (r.top - pad >= bh + abstand + rand) top = r.top - pad - abstand - bh;
  else if (W - (r.right + pad) >= bw + abstand + rand) { top = seitlich; links = r.right + pad + abstand; }
  else if (r.left - pad >= bw + abstand + rand) { top = seitlich; links = r.left - pad - abstand - bw; }
  else top = H - bh - rand;
  links = Math.min(Math.max(links, rand), W - bw - rand);
  blase.style.left = Math.round(links) + 'px';
  blase.style.top = Math.round(Math.min(Math.max(rand, top), H - bh - rand)) + 'px';
}

/* ---- Angebot beim ersten Start ----
 * Einmal, über dem ©-Kasten. Gilt als gemacht, sobald es gezeigt wurde — wer
 * Nein sagt, wird nicht wieder gefragt; das ? bleibt. Wer die App über einen
 * geteilten Link öffnet, will zuerst sein Ergebnis sehen: dann kein Angebot. */

function tourAngebotLage() {
  const el = $('#tourAngebot');
  if (el.hidden) return;
  const k = $('.quellen-kasten').getBoundingClientRect();
  el.style.left = Math.round(Math.min(k.left, window.innerWidth - el.offsetWidth - 10)) + 'px';
  el.style.bottom = Math.round(window.innerHeight - k.top + 8) + 'px';
}

function tourAngebotZu() {
  $('#tourAngebot').hidden = true;
  window.removeEventListener('resize', tourAngebotLage);
}

function tourAngebot() {
  if (prefs.tourAngeboten || location.hash.length > 1) return;
  prefs.tourAngeboten = true;
  saveStore();
  $('#tourAngebot').hidden = false;
  tourAngebotLage();
  window.addEventListener('resize', tourAngebotLage);
  // Ein Griff auf die Karte heißt: jetzt nicht
  map.getContainer().addEventListener('pointerdown', tourAngebotZu, { once: true, passive: true });
}

function tourEinrichten() {
  $('#tourBtn').addEventListener('click', tourStart);
  $('#tourZu').addEventListener('click', tourEnde);
  $('#tourWeiter').addEventListener('click', () => tourZeigen(tourIndex + 1));
  $('#tourZurueck').addEventListener('click', () => tourZeigen(tourIndex - 1));
  $('#tourAngebotJa').addEventListener('click', tourStart);
  $('#tourAngebotNein').addEventListener('click', tourAngebotZu);
  // Erst wenn die Karte steht, sonst springt das Angebot beim Aufbau umher
  setTimeout(tourAngebot, 1500);
}

// Nach boot() aus app.js: der Zuhörer dort ist zuerst eingetragen
document.addEventListener('DOMContentLoaded', tourEinrichten);
