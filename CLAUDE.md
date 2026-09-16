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

## Icons

`icon.svg` ist die Vorlage, `make-icons.ps1` rasterisiert daraus die PNGs in
`icons/`. Motiv und Strichführung sind **dieselben wie beim Kachel-Icon auf der
Übersichtsseite** (`steidlmichael2000-stack.github.io`, `index.html`, Karte
`.card-rail`) — wer das eine ändert, ändert auch das andere, sonst fällt die
Icon-Familie wieder auseinander.

## Beim Deployen

`VERSION` in `sw.js` hochzählen. Der Worker arbeitet zwar „erst Netz, dann
Cache", aber die Kachel- und Netzdaten-Caches hängen an der Version.
