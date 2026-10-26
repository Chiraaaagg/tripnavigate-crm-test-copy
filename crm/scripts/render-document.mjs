#!/usr/bin/env node
// Render one customer document view to HTML (B1.2 Phase F; no network, no photos, no PDF).
//
// Usage:
//   node scripts/render-document.mjs < view.json > document.html
//
// stdin:  {"title"?: string, "view": QuotationDocumentView | ItineraryDocumentView}
//         (crm/src/modules/documents/contracts.ts; built by the documents server code
//         under the staff member's own session, never from raw rows)
// stdout: the HTML document (only when rendered)
// stderr: one JSON line {outcome, placeholders?, internalNotes?, refusals?, safetyHits?, issue?}
//         codes and paths only, never customer text
// exit:   0 rendered (placeholders > 0 = preview only), 2 refused by the adapter,
//         3 unsafe page text, 4 a network attempt was blocked, 1 invalid input or failure
//
// Why a script: react-dom/server cannot load in the Next.js React Server Components
// layer, so the HTML/PDF render runs outside the app (this script now; the approved
// render worker later). The in-app preview renders the same template component
// directly as a Server Component. The TSX sources are loaded through Vite's
// module runner (Vite is installed with the pinned test tooling); a production
// worker would bundle them instead (decision PENDING with the rendering location).
//
// No network (review E5-10): ./lib/no-network.mjs is imported FIRST and replaces every
// outbound entry point (http, https, http2, net, tls, dgram, dns, fetch/undici,
// WebSocket) with a stub that exits with code 4 before anything else is loaded.
import './lib/no-network.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crm = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(outcome, extra, code) {
  process.stderr.write(`${JSON.stringify({ outcome, ...extra })}\n`);
  process.exit(code);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  fail('invalid_input', { issue: 'json' }, 1);
}

let renderView;
try {
  const { runnerImport } = await import('vite');
  const loaded = await runnerImport(join(crm, 'src/modules/documents/render/render-view.ts'), {
    root: crm,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: /^@\//, replacement: `${join(crm, 'src')}/` },
        // `server-only` throws outside the React Server Components condition; this
        // process is server-side by construction.
        { find: /^server-only$/, replacement: join(crm, 'scripts/lib/server-only-empty.mjs') },
      ],
    },
  });
  renderView = loaded.module.renderView;
} catch {
  fail('invalid_input', { issue: 'renderer_unavailable' }, 1);
}

const result = renderView(payload);
switch (result.outcome) {
  case 'rendered':
    process.stdout.write(result.html);
    process.stderr.write(`${JSON.stringify({ outcome: 'rendered', placeholders: result.placeholders, internalNotes: result.internalNotes })}\n`);
    process.exit(0);
    break;
  case 'refused':
    fail('refused', { refusals: result.refusals }, 2);
    break;
  case 'unsafe_page':
    fail('unsafe_page', { safetyHits: result.safetyHits }, 3);
    break;
  default:
    fail('invalid_input', { issue: result.issue }, 1);
}
