// Blocks every outbound network entry point of this Node process (B1.2 render script,
// review E5-10). Import it FIRST. Any attempt writes one JSON line to stderr
// ({"outcome":"network_blocked","api":"<name>"}) and exits with code 4 at once, so
// nothing can catch and ignore it. No values or addresses are printed.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
export const NETWORK_BLOCKED_EXIT = 4;

function blocked(api) {
  return function networkBlocked() {
    process.stderr.write(`${JSON.stringify({ outcome: 'network_blocked', api })}\n`);
    process.exit(NETWORK_BLOCKED_EXIT);
  };
}

function stub(mod, name, keys) {
  for (const key of keys) {
    if (typeof mod[key] === 'function') mod[key] = blocked(`${name}.${key}`);
  }
}

const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dns = require('node:dns');

stub(http, 'http', ['request', 'get']);
stub(https, 'https', ['request', 'get']);
stub(http2, 'http2', ['connect']);
stub(net, 'net', ['connect', 'createConnection']);
stub(tls, 'tls', ['connect']);
stub(dgram, 'dgram', ['createSocket']);
stub(dns, 'dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'reverse']);
stub(dns.promises, 'dns.promises', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'reverse']);
// A socket created any other way still cannot connect.
net.Socket.prototype.connect = blocked('net.Socket.connect');

// fetch / undici (the built-in fetch stack), WebSocket and EventSource.
globalThis.fetch = blocked('fetch');
for (const key of ['WebSocket', 'EventSource']) {
  if (key in globalThis) globalThis[key] = blocked(key);
}
try {
  const undici = require('undici');
  stub(undici, 'undici', ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade']);
} catch {
  // undici is not installed as a package: the built-in fetch above is the only entry.
}

// ESM `import { request } from 'node:http'` sees the stubs too.
syncBuiltinESMExports();
