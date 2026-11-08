import 'server-only';

/**
 * Single entry the Node render worker script loads through Vite's module
 * runner (crm/scripts/render-worker.mjs). Not for the Next.js app.
 */
export { processOneJob, type JobOutcome } from './worker-core';
export { renderPdf } from './pdf';
export { renderView } from './render-view';
export { createLocalWorkerDeps } from '../server/render-worker-deps';
