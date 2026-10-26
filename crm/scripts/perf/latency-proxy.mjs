#!/usr/bin/env node
// Loopback HTTP proxy that adds a fixed delay to every request before passing
// it to the local Supabase API gateway. Used to emulate the hosted network
// cost of one Supabase round trip in local speed measurements: build and start
// the app with NEXT_PUBLIC_SUPABASE_URL pointing at this proxy.
//
//   node scripts/perf/latency-proxy.mjs [listenPort=55421] [targetPort=55321] [delayMs=10]
import { createServer, request } from 'node:http';

const listenPort = Number(process.argv[2] ?? 55421);
const targetPort = Number(process.argv[3] ?? 55321);
const delayMs = Number(process.argv[4] ?? 10);

createServer((req, res) => {
  setTimeout(() => {
    const upstream = request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }, delayMs);
}).listen(listenPort, '127.0.0.1', () => console.log(`latency-proxy 127.0.0.1:${listenPort} -> :${targetPort}, +${delayMs} ms per request`));
