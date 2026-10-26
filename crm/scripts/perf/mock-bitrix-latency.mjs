#!/usr/bin/env node
// SYNTHETIC Bitrix24 REST stand-in with a fixed delay per call, for local
// speed measurements of the Bitrix sync admin page only. Listens on loopback;
// answers the read methods that page uses with synthetic pipelines, users and
// a deal total. Never the real portal.
//
//   node scripts/perf/mock-bitrix-latency.mjs [port=55390] [delayMs=200]
//   BITRIX_WEBHOOK_BASE_URL=http://127.0.0.1:55390/rest/1/perfSyntheticWebhook0001/
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 55390);
const delayMs = Number(process.argv[3] ?? 200);
let calls = 0;

const categories = [7, 9, 11].map((id) => ({ id, name: `Synthetic pipeline ${id}` }));
const stages = (entity) =>
  Array.from({ length: 8 }, (_, i) => ({
    STATUS_ID: entity === 'DEAL_STAGE' ? `S${i}` : `C${entity.split('_').pop()}:S${i}`,
    NAME: `Stage ${i}`,
    SEMANTICS: i === 6 ? 'S' : i === 7 ? 'F' : null,
  }));
const users = (active) =>
  Array.from({ length: active ? 80 : 20 }, (_, i) => ({
    ID: String((active ? 100 : 500) + i),
    NAME: `Synthetic${i}`,
    LAST_NAME: active ? 'Active' : 'Former',
    EMAIL: `synthetic.${active ? 'a' : 'f'}${i}@example.test`,
    ACTIVE: active,
  }));

function answer(method, body) {
  const start = Number(body.start ?? 0);
  switch (method) {
    case 'crm.category.list':
      return { result: { categories } };
    case 'crm.status.list':
      return { result: stages(body.filter?.ENTITY_ID ?? 'DEAL_STAGE') };
    case 'user.get': {
      const all = users(body.FILTER?.ACTIVE !== false);
      const page = all.slice(start, start + 50);
      return { result: page, next: start + 50 < all.length ? start + 50 : undefined, total: all.length };
    }
    case 'crm.deal.list':
      return { result: [{ ID: '900001' }], next: 50, total: 1800 };
    default:
      return null;
  }
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls }));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls += 1;
    const method = (req.url ?? '').split('/').pop()?.replace(/\.json$/, '') ?? '';
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const out = answer(method, body);
    setTimeout(() => {
      res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ? { ...out, time: { start: 0 } } : { error: 'ERROR_METHOD_NOT_FOUND' }));
    }, delayMs);
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-bitrix-latency on 127.0.0.1:${port}, ${delayMs} ms per call`));
