/* Den Höhendaten-Proxy lokal laufen lassen — derselbe Code wie auf Cloudflare.
 *
 *   node werkzeug/proxy/lokal.mjs [port]      (Vorgabe 8787)
 *
 * Node bringt fetch, Request und Response selbst mit. Hier wird nur die
 * HTTP-Anfrage in ein Request übersetzt und die Antwort zurückgeschrieben. */

import http from 'node:http';
import { Readable } from 'node:stream';
import worker from './worker.js';

const port = Number(process.argv[2]) || 8787;

http.createServer(async (req, res) => {
  try {
    const anfrage = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers });
    const antwort = await worker.fetch(anfrage);
    res.writeHead(antwort.status, Object.fromEntries(antwort.headers));
    if (antwort.body) Readable.fromWeb(antwort.body).pipe(res);
    else res.end();
  } catch (fehler) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(fehler));
  }
}).listen(port, () => console.log(`Höhendaten-Proxy auf http://localhost:${port}`));
