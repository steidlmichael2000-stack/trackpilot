#!/usr/bin/env python3
"""Baut die mitgelieferte Kilometrierung aus den Infrastrukturdaten der DB InfraGO.

Quelle ist das GeoPackage „Infrastrukturdaten der DB InfraGO" aus der Mobilithek
(https://mobilithek.info, Datenstand Mai 2026). Lizenz laut Angebotsseite
CC BY 4.0, Quellenvermerk "DB InfraGO" -- das Paket selbst nennt keine. Es enthaelt die
Streckenachsen in Abschnitten mit Kilometer von/bis, im Median 0,86 km lang.
Die Linie ist auf die Kilometrierung abgestimmt: Ihre Laenge weicht im Median
0,1 m von der Kilometerdifferenz ab. Ein Kilometer laesst sich darauf also
einfach anteilig abtragen.

Nachgemessen am 13.10.2026 an 6271 Bahnuebergaengen, deren Lage in
OpenStreetMap (Strasse kreuzt Gleis) nichts mit einer Kilometrierung zu tun
hat: Der Kilometer des Bahnuebergangs, auf dieser Linie abgetragen, lag im
Median 2,5 m daneben, im ungünstigen Zehntel 6,3 m. Zwischen zwei
OSM-Kilometersteinen interpoliert waren es 9,9 m und 44 m.

Aufruf:

    python werkzeug/infrago-bauen.py Pfad/zu/Infrastrukturdaten.gpkg

Schreibt nach infrago/:
    index.json      Stand, Quelle, je 0,1-Grad-Zelle die Streckennummern darin
    s/<nr>.json     je Strecke die Abschnitte: [Richtung, km von, km bis, Linie]
    bs.json         Betriebsstellen mit DS100, Art, Strecke, km und Lage

Die Linie ist eine Google-Polyline mit Faktor 1e6 (rund 0,1 m), vereinfacht
mit Douglas-Peucker auf VEREINFACHUNG Meter. Die Laenge aendert sich dadurch
um Zentimeter, und auf die Laenge kommt es beim Abtragen an.
"""

import argparse
import json
import math
import os
import sqlite3
import struct
from collections import defaultdict

# Zellen des Index. Mit 0,5 Grad wie bei den Netzkacheln lagen um Frankfurt
# ueber 80 Strecken in einer Zelle, und ein einziger Tipp lud sie alle. Mit
# 0,1 Grad (rund 11 x 7 km) sind es auch dort nur noch eine Handvoll.
RASTER = 0.1
VEREINFACHUNG = 0.5          # Meter
RICHTUNG = {'Streckenachse': 0, 'Richtungsgleis': 1, 'Gegenrichtungsgleis': 2}

# ---------------------------------------------------------------- UTM 32 <-> Grad (ETRS89)
# Krueger-Reihen wie in hoehen.js; auf Millimeter genau in ganz Deutschland.
A_ = 6378137.0
F_ = 1 / 298.257222101
N_ = F_ / (2 - F_)
GROSS_A = A_ / (1 + N_) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64)
BETA = [N_ / 2 - 2 * N_ ** 2 / 3 + 37 * N_ ** 3 / 96,
        N_ ** 2 / 48 + N_ ** 3 / 15,
        17 * N_ ** 3 / 480]
DELTA = [2 * N_ - 2 * N_ ** 2 / 3 - 2 * N_ ** 3,
         7 * N_ ** 2 / 3 - 8 * N_ ** 3 / 5,
         56 * N_ ** 3 / 15]


def utm_zurueck(ost, nord):
    xi = nord / (0.9996 * GROSS_A)
    eta = (ost - 500000) / (0.9996 * GROSS_A)
    xs = xi - sum(BETA[j] * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j in range(3))
    es = eta - sum(BETA[j] * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j in range(3))
    chi = math.asin(math.sin(xs) / math.cosh(es))
    phi = chi + sum(DELTA[j] * math.sin(2 * (j + 1) * chi) for j in range(3))
    lam = math.atan2(math.sinh(es), math.cos(xs))
    return math.degrees(phi), 9 + math.degrees(lam)


# ---------------------------------------------------------------- GeoPackage
def wkb(b, o=0):
    E = '<' if b[o] == 1 else '>'
    typ = struct.unpack_from(E + 'I', b, o + 1)[0]
    o += 5
    base = typ % 1000
    dim = 2 + (typ // 1000 in (1, 2)) + (typ // 1000 == 3) * 2
    if base in (1, 2, 8):
        k = 1 if base == 1 else struct.unpack_from(E + 'I', b, o)[0]
        if base != 1:
            o += 4
        pts = [struct.unpack_from(E + 'dd', b, o + i * 8 * dim) for i in range(k)]
        return [pts], o + k * 8 * dim
    if base in (5, 9, 11):
        k = struct.unpack_from(E + 'I', b, o)[0]
        o += 4
        raus = []
        for _ in range(k):
            r, o = wkb(b, o)
            raus += r
        if base == 9:                       # CompoundCurve: ein Zug
            zug = []
            for p in raus:
                zug += p if not zug else p[1:]
            return [zug], o
        return raus, o
    raise ValueError('Geometrietyp %d' % typ)


def gpgeom(b):
    env = (b[3] >> 1) & 7
    return wkb(b, 8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env])[0]


# ---------------------------------------------------------------- Geometrie
def rdp(pts, tol):
    """Douglas-Peucker in UTM-Metern."""
    if len(pts) < 3:
        return pts[:]
    behalten = [False] * len(pts)
    behalten[0] = behalten[-1] = True
    stapel = [(0, len(pts) - 1)]
    while stapel:
        i, j = stapel.pop()
        if j <= i + 1:
            continue
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        weit, wo = -1.0, None
        for k in range(i + 1, j):
            px, py = pts[k]
            t = ((px - ax) * dx + (py - ay) * dy) / L2 if L2 > 0 else 0.0
            t = max(0.0, min(1.0, t))
            d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > weit:
                weit, wo = d, k
        if weit > tol:
            behalten[wo] = True
            stapel += [(i, wo), (wo, j)]
    return [p for p, b in zip(pts, behalten) if b]


def kodieren(pts, faktor=1e6):
    raus, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = int(round(lat * faktor)), int(round(lon * faktor))
        for d in (ilat - plat, ilon - plon):
            d = ~(d << 1) if d < 0 else (d << 1)
            while d >= 0x20:
                raus.append(chr((0x20 | (d & 0x1f)) + 63))
                d >>= 5
            raus.append(chr(d + 63))
        plat, plon = ilat, ilon
    return ''.join(raus)


def km_aus(km, m):
    """'170,9 + 58' steht als km 170.9 und m 58 in der Datei: 170,958.
    Der Meterteil kann ueber 100 liegen (Ueberlaenge) — einfach addieren.
    Bei einigen Tunneln fehlt er; ohne Kilometer gibt es None."""
    if km is None:
        return None
    return round(km + (m or 0) / 1000.0, 6)


def kachel(lat, lon):
    return '%d_%d' % (math.floor(lat / RASTER), math.floor(lon / RASTER))


# ---------------------------------------------------------------- Bau
def bauen(gpkg, ziel):
    c = sqlite3.connect(gpkg)
    strecken = defaultdict(list)
    kacheln = defaultdict(set)
    zaehler = defaultdict(int)
    stuetz_roh = stuetz = 0

    sql = ('select Streckennummer, Richtung, km_von_km, km_von_m, km_bis_km, km_bis_m, geom '
           'from "M1 Streckennetz" order by Streckennummer, km_von_i')
    for nr, ri, vk, vm, bk, bm, g in c.execute(sql):
        if ri not in RICHTUNG:
            zaehler['richtung?' + str(ri)] += 1
            continue
        a, b = km_aus(vk, vm), km_aus(bk, bm)
        teile = gpgeom(g)
        if len(teile) != 1:
            # Mehrteilig sind 169 von 33425 Abschnitten. Zwei stossen aneinander
            # und werden verbunden. In den uebrigen ist der zweite Teil meist
            # dieselbe Linie noch einmal, rueckwaerts und versetzt (Strecke 1232:
            # 651 m und 651 m, 654 m auseinander), oder ein Bruchstueck. Genommen
            # wird der Teil, dessen Laenge zur Kilometerdifferenz passt.
            zug = teile[0]
            ok = True
            for t in teile[1:]:
                if math.dist(zug[-1], t[0]) < 1:
                    zug = zug + t[1:]
                else:
                    ok = False
                    break
            if ok:
                zaehler['mehrteilig, verbunden'] += 1
            else:
                laenge = lambda p: sum(math.dist(p[i - 1], p[i]) for i in range(1, len(p)))
                soll = abs(b - a) * 1000
                zug = min(teile, key=lambda p: abs(laenge(p) - soll))
                if abs(laenge(zug) - soll) > max(20, 0.05 * soll):
                    zaehler['mehrteilig, kein Teil passt'] += 1
                    continue
                zaehler['mehrteilig, passender Teil'] += 1
        else:
            zug = teile[0]
        if len(zug) < 2:
            zaehler['ohne Linie'] += 1
            continue
        stuetz_roh += len(zug)
        einfach = rdp(zug, VEREINFACHUNG)
        stuetz += len(einfach)
        ll = [utm_zurueck(x, y) for x, y in einfach]
        strecken[nr].append([RICHTUNG[ri], a, b, kodieren(ll)])
        zaehler[ri] += 1
        # Jede Zelle, die das Rechteck einer Kante beruehrt. Stichproben entlang
        # der Kante (anfangs alle 500 m) verfehlten Zellen, die eine Kante nur an
        # der Ecke streift: Im Rundlauf fanden 2931 km 307,524 und 4120 km 127,411
        # ihre eigene Strecke nicht wieder. Das Rechteck nimmt lieber eine Zelle
        # zu viel.
        for i in range(1, len(ll)):
            (la0, lo0), (la1, lo1) = ll[i - 1], ll[i]
            for y in range(math.floor(min(la0, la1) / RASTER), math.floor(max(la0, la1) / RASTER) + 1):
                for x in range(math.floor(min(lo0, lo1) / RASTER), math.floor(max(lo0, lo1) / RASTER) + 1):
                    kacheln['%d_%d' % (y, x)].add(nr)

    os.makedirs(os.path.join(ziel, 's'), exist_ok=True)
    for alt in os.listdir(os.path.join(ziel, 's')):
        os.remove(os.path.join(ziel, 's', alt))
    groesse = 0
    for nr, abschnitte in strecken.items():
        text = json.dumps({'g': abschnitte}, separators=(',', ':'))
        with open(os.path.join(ziel, 's', '%d.json' % nr), 'w', encoding='utf-8') as f:
            f.write(text)
        groesse += len(text)

    # Anlagen fuer die Kartenauflage, je Strecke eine eigene Datei unter o/ --
    # die Kilometerrechnung braucht sie nicht und soll sie nicht mitladen.
    #   u: Bahnuebergaenge  [km, lat, lon, Bezeichnung, Sicherung, Strassenart]
    #   b: Bruecken         [km von, km bis, Laenge m, Bezeichnung, Kreuzungsart, Linie]
    #   t: Tunnel           [km von, km bis, Laenge m, Bezeichnung, Linie]
    # Je Gleis erfasst wie das Streckennetz; genau gleiche Zeilen (Strecke,
    # km von/bis, Bezeichnung, Gleis) gibt es ein Dutzend Mal und nur einmal.
    anlagen = defaultdict(lambda: {'u': [], 'b': [], 't': []})
    gesehen = set()
    for nr, ri, vk, vm, bk, bm, bez, sich, strasse, lat, lon in c.execute(
            'select Streckennummer, Richtung, km_von_km, km_von_m, km_bis_km, km_bis_m, Bezeichnung, '
            '"Technische Sicherung", "Straßenart", "Geographische Breite (EPSG 4326)", '
            '"Geographische Länge (EPSG 4326)" from "M1 Bahnübergänge"'):
        if vk is None or bk is None or lat is None:
            continue
        km = round((km_aus(vk, vm) + km_aus(bk, bm)) / 2, 4)
        k = ('u', nr, km, bez, ri)
        if k in gesehen:
            continue
        gesehen.add(k)
        anlagen[nr]['u'].append([km, round(lat, 6), round(lon, 6), bez or '', sich or '', strasse or ''])
        zaehler['Bahnuebergaenge'] += 1

    def linie(g):
        teile = gpgeom(g)
        zug = max(teile, key=lambda p: sum(math.dist(p[i - 1], p[i]) for i in range(1, len(p))))
        return kodieren([utm_zurueck(x, y) for x, y in rdp(zug, VEREINFACHUNG)]) if len(zug) > 1 else ''

    for nr, ri, vk, vm, bk, bm, laenge, bez, art, g in c.execute(
            'select Streckennummer, Richtung, km_von_km, km_von_m, km_bis_km, km_bis_m, "Länge", Bezeichnung, '
            'Kreuzungsart, geom from "M1 Eisenbahnbrücken"'):
        a, b = km_aus(vk, vm), km_aus(bk, bm)
        k = ('b', nr, a, b, bez, ri)
        if k in gesehen or g is None or a is None or b is None:
            zaehler['Bruecken ohne km oder Linie'] += a is None or b is None or g is None
            continue
        gesehen.add(k)
        p = linie(g)
        if p:
            anlagen[nr]['b'].append([a, b, laenge, bez or '', art or '', p])
            zaehler['Bruecken'] += 1
    for nr, ri, vk, vm, bk, bm, laenge, bez, g in c.execute(
            'select Streckennummer, Richtung, km_von_km, km_von_m, km_bis_km, km_bis_m, "Länge", Bezeichnung, '
            'geom from "M1 Tunnel"'):
        a, b = km_aus(vk, vm), km_aus(bk, bm)
        k = ('t', nr, a, b, bez, ri)
        if k in gesehen or g is None or a is None or b is None:
            zaehler['Tunnel ohne km oder Linie'] += a is None or b is None or g is None
            continue
        gesehen.add(k)
        p = linie(g)
        if p:
            anlagen[nr]['t'].append([a, b, laenge, bez or '', p])
            zaehler['Tunnel'] += 1

    os.makedirs(os.path.join(ziel, 'o'), exist_ok=True)
    for alt in os.listdir(os.path.join(ziel, 'o')):
        os.remove(os.path.join(ziel, 'o', alt))
    groesse_o = 0
    for nr, d in anlagen.items():
        text = json.dumps(d, separators=(',', ':'), ensure_ascii=False)
        with open(os.path.join(ziel, 'o', '%d.json' % nr), 'w', encoding='utf-8') as f:
            f.write(text)
        groesse_o += len(text.encode())
    print('Anlagen: %d Dateien, %.2f MB' % (len(anlagen), groesse_o / 1048576))

    # Betriebsstellen: eine Zeile je Strecke, an der sie liegt
    bs = []
    for row in c.execute('select Bezeichnung, "Kürzel", "Art lang", Art, Streckennummer, km_lage_km, km_lage_m, '
                         '"Geographische Breite (EPSG 4326)", "Geographische Länge (EPSG 4326)", Betriebszustand '
                         'from "M1 Betriebsstellen"'):
        name, ds100, art_lang, art, nr, lk, lm, lat, lon, zustand = row
        if lat is None or lon is None:
            continue
        km = km_aus(lk, lm) if lk is not None else None
        bs.append([name or '', ds100 or '', art_lang or art or '', str(nr or ''), km,
                   round(lat, 6), round(lon, 6), zustand or ''])
    with open(os.path.join(ziel, 'bs.json'), 'w', encoding='utf-8') as f:
        json.dump(bs, f, separators=(',', ':'), ensure_ascii=False)

    index = {
        'stand': '2026-05',
        'quelle': 'DB InfraGO, Infrastrukturdaten (Mobilithek), CC BY 4.0, bearbeitet - erzeugt mit werkzeug/infrago-bauen.py',
        'raster': RASTER,
        'vereinfachung_m': VEREINFACHUNG,
        'kacheln': {k: sorted(v) for k, v in sorted(kacheln.items())},
        # Welche Strecken eine Datei unter o/ haben. Ohne die Liste fragte die
        # Auflage auch die rund 200 ohne Anlagen ab und bekam je ein 404.
        'anlagen': sorted(anlagen.keys()),
    }
    with open(os.path.join(ziel, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)

    # Prueffaelle fuer werkzeug/infrago-pruefen.mjs: jeder achte Bahnuebergang
    # mit km und der Lage, die InfraGO selbst fuer ihn angibt.
    probe = []
    for i, (nr, vk, vm, bk, bm, lat, lon) in enumerate(c.execute(
            'select Streckennummer, km_von_km, km_von_m, km_bis_km, km_bis_m, '
            '"Geographische Breite (EPSG 4326)", "Geographische Länge (EPSG 4326)" '
            'from "M1 Bahnübergänge" order by id')):
        if i % 8 == 0 and lat is not None:
            probe.append([str(nr), round((km_aus(vk, vm) + km_aus(bk, bm)) / 2, 6), round(lat, 7), round(lon, 7)])
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'infrago-probe.json'), 'w', encoding='utf-8') as f:
        json.dump(probe, f, separators=(',', ':'))

    print('%d Strecken, %d Abschnitte, %d -> %d Stuetzpunkte, %.2f MB Linien' %
          (len(strecken), sum(len(v) for v in strecken.values()), stuetz_roh, stuetz, groesse / 1048576))
    je = sorted(len(v) for v in kacheln.values())
    print('%d Betriebsstellen-Zeilen, %d Zellen, Strecken je Zelle: Median %d, hoechstens %d, Index %.0f kB' %
          (len(bs), len(kacheln), je[len(je) // 2], je[-1], os.path.getsize(os.path.join(ziel, 'index.json')) / 1024))
    for k, v in sorted(zaehler.items()):
        print('  %-28s %d' % (k, v))


def pruefen(gpkg):
    """Rueckrechnung gegen die Grad-Spalten der Bahnuebergaenge."""
    c = sqlite3.connect(gpkg)
    schlechtester = 0.0
    for x, y, lat, lon in c.execute('select "UTM Rechtswert (EPSG 25832)", "UTM Hochwert (EPSG 25832)", '
                                    '"Geographische Breite (EPSG 4326)", "Geographische Länge (EPSG 4326)" '
                                    'from "M1 Bahnübergänge"'):
        la, lo = utm_zurueck(x, y)
        d = math.hypot((la - lat) * 111200, (lo - lon) * 111200 * math.cos(math.radians(lat)))
        schlechtester = max(schlechtester, d)
    print('UTM -> Grad gegen die Spalten der Datei: schlechtester Punkt %.3f m' % schlechtester)
    if schlechtester > 0.05:
        raise SystemExit('Umrechnung stimmt nicht')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('gpkg')
    ap.add_argument('--ziel', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'infrago'))
    a = ap.parse_args()
    pruefen(a.gpkg)
    bauen(a.gpkg, os.path.normpath(a.ziel))
