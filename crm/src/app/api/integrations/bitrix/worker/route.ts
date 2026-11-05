import { runIntakeWorker } from '@/modules/integration/server/runtime';

/**
 * Intake worker triggers. Each runs one bounded batch (or `?task=reconcile`,
 * `?task=sync`, `?task=health`) synchronously and returns its counts. The only
 * work after the response is the sync-stopped alert check (after()).
 *   GET   Vercel Cron on Production (Authorization: Bearer CRON_SECRET)
 *   POST  manual run or pg_cron + pg_net (Authorization: Bearer INTAKE_WORKER_SECRET)
 */
export const maxDuration = 90;

export async function GET(request: Request): Promise<Response> {
  return runIntakeWorker(request, 'cron');
}

export async function POST(request: Request): Promise<Response> {
  return runIntakeWorker(request, 'manual');
}
