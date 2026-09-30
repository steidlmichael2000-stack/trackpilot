# TrackPilot

Streckennummer und Kilometer eingeben, Position auf der Karte sehen.
Live unter <https://steidlmichael2000-stack.github.io/trackpilot/>.

## Die App hieß bis September 2026 „Railnav"

Umbenannt am 15.09.2026, weil Geo++ unter <https://db.geopp.de/gnportal/> ein
kommerzielles Produkt namens **RaiLNav** vertreibt (Android-App und Web-Dienst
für das Streckennetz der DB InfraGO). Der alte Name darf nirgends wieder
auftauchen — weder als Produktname noch in Texten, Titeln oder Repo-Pfaden.

Mit umgezogen sind: Repo-Name, GitHub-Pages-Pfad (`/railnav/` → `/trackpilot/`),
`manifest.webmanifest` (`name`, `short_name`, `id`), Seitentitel, README und
alle Cache-Namen im Service Worker.

### Drei Stellen tragen den alten Namen absichtlich weiter

Nicht „aufräumen" — sie hängen an gespeicherten Nutzerdaten, und die liegen am
Origin, nicht am Pfad. Ein neuer Name würde sie verwaisen lassen:

| Stelle | Datei | Warum |
|---|---|---|
| `STORE_KEY_ALT = 'railnav.v3'` | `app.js` | Einstellungen und Verlauf werden beim ersten Start übernommen und danach unter dem neuen Schlüssel gespeichert. |
| `KML_DB_ALT = 'railnav-kml'` | `app.js` | Die Datenbank mit den importierten KML-Dateien. Sie heißt seit dem 16.09.2026 `trackpilot-kml`; der alte Name steht nur noch im einmaligen Umzug (`kmlUmziehen`), der den Bestand herüberkopiert und die alte Datenbank danach löscht. |
| `ALT_PRAEFIX = 'railnav-'` | `sw.js` | Räumt die Caches der alten Fassung weg, die sonst dauerhaft auf dem Gerät lägen. |

Diese drei Migrationspfade dürfen frühestens weg, wenn sicher ist, dass niemand
mehr eine Fassung von vor der Umbenennung installiert hat. Sie sind **nicht**
der Produktname, sondern die Schlüssel, unter denen fremde Geräte ihre eigenen
Daten liegen haben — wer sie streicht, löscht die Daten dieser Geräte mit.

## Signalfarbe

Umschaltbar, Standard ist **Lapis** (`#1761A3`) — der Blauton des Firmenlogos.
Die Farben stehen in `PALETTEN` in `app.js`, **nicht** im Stylesheet: jede Farbe
braucht einen eigenen Ton für Hell und für Dunkel, und die Wahl muss zur
Laufzeit umschaltbar sein. `applyPalette()` setzt `--accent` und `--accent-ink`
als Inline-Wert auf `<html>` und schlägt damit beide Themenblöcke in `style.css`,
die nur noch Rückfallwerte tragen.

Der Logoton selbst steht auf dem dunklen Grund nur bei 3:1 und ist dort für
Beschriftungen zu dunkel — im Dunkelmodus läuft deshalb ein aufgehellter Ton
derselben Farbe (`#55A5E7`). `ink` ist die Schrift auf gefüllten Flächen und
wechselt je Ton zwischen Schwarz und Weiß. Wer eine Farbe ergänzt, prüft beide
Richtungen.

Bei `theme: 'auto'` hängt die Wahl am Betriebssystem — dafür liegt ein
`matchMedia`-Zuhörer in `bind()`. Ohne ihn bliebe der Ton beim Umschalten des
Geräts stehen.

`icon.svg`, die PNGs und die Kachel `.card-rail` auf MS Tools sind seit
September 2026 ebenfalls Lapis. Die Icon-Adressen tragen `?v=lapis`, damit
installierte Apps das alte violette Icon nicht aus dem Zwischenspeicher weiter
zeigen — bei einem neuen Motiv den Wert ändern.

## Icons

`icon.svg` ist die Vorlage, `make-icons.ps1` rasterisiert daraus die PNGs in
`icons/`. Motiv und Strichführung sind **dieselben wie beim Kachel-Icon auf der
Übersichtsseite** (`steidlmichael2000-stack.github.io`, `index.html`, Karte
`.card-rail`) — wer das eine ändert, ändert auch das andere, sonst fällt die
Icon-Familie wieder auseinander.

## Dunkle Karte, Straßen und Ortsnamen: OpenFreeMap über MapLibre

OpenFreeMap gibt es nur als Vektorkarte. MapLibre GL (`vendor/maplibre/`) zeichnet sie in
`#glKarte` **hinter** der Leaflet-Karte und folgt ihr nur (`glNachziehen` in `app.js`). Nicht
als Leaflet-Ebene einbauen: leaflet-rotate dreht die Kachelebene per CSS, eine gedrehte
bildschirmgroße Fläche hätte leere Ecken.

MapLibre zeichnet zweierlei (`glStil`): die dunkle Karte als fertigen Stil, oder ein Bild
(Luftbild, DOP20, Relief) mit **Straßen und Ortsnamen** als Vektoren darüber. Im zweiten Fall
zeichnet MapLibre auch das Bild, und die Leaflet-Grundkarte ist aus (`grundAnwenden`) — nur so
liegen die Straßen zwischen Bild und Bahn-Layer. Die Bilddienste stehen dafür zweimal im Code:
als Leaflet-Ebene in `initMap` und in `GL_BILDER`. Wer einen Dienst ändert, ändert beide.
Straßen und Ortsnamen kamen bis 30.09.2026 als Rasterkacheln von Esri: auf dem Land ab
Zoomstufe 16 leer und auf dem Handy unscharf. Nicht zurückbauen.
Über der dunklen Karte ersetzen unsere Straßen und Namen deren eigene (`glDunkelErsetzt`,
Bahnlinien `railway…` bleiben). Dafür wird der dunkle Stil einmal als JSON geholt; bis er da
ist, steht die dunkle Karte unverändert.

- Beide Karten liegen nachgemessen auf 0,000 px übereinander — verschoben, gezoomt, gedreht,
  mitten in der Zweifinger-Geste und nach animiertem Zoom. Wer an `glLage` oder den Ereignissen
  dreht, misst das nach (Punkte mit `map.project` ungerundet gegen `gl.project`).
  `map.getCenter()` taugt dafür nicht: Nach `setView` meldet es die gewünschte Mitte, gezeichnet
  ist die auf ganze Pixel gerundete (0,47 px daneben).
- MapLibre wird erst geladen, wenn die Wahl es braucht (`glGebraucht`): rund 1,2 MB.
- **Update nur bewusst:** Version aus der npm-Registry holen, gegen `dist.integrity` (SHA-512)
  prüfen, keine Version nehmen, die erst ein paar Tage alt ist. Am 30.09.2026 so mit 6.10.0
  gemacht. Kopiert werden `maplibre-gl.mjs`, `maplibre-gl-shared.mjs`, `maplibre-gl-worker.mjs`,
  `maplibre-gl.css` und `LICENSE.txt`.
- Der Worker startet als eigene Datei vom selben Ort. Die CSP bleibt dadurch bei
  `script-src 'self'` und `worker-src 'self'` — nicht auf `blob:` oder `unsafe-eval` lockern.
- Im Service Worker: Stil (`/styles/…`) und Kachelbeschreibung (`/planet`) von OpenFreeMap
  „erst Netz", weil sie auf den wöchentlich neuen Datenstand zeigen; Kacheln, Schriften und
  Symbole „erst Cache".

## Beim Deployen

`VERSION` in `sw.js` hochzählen. Der Worker arbeitet zwar „erst Netz, dann
Cache", aber die Kachel- und Netzdaten-Caches hängen an der Version.
