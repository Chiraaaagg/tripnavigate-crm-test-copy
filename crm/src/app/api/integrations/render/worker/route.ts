import { handleOnlineRenderRequest, productionOnlineDeps } from '@/modules/documents/server/render-online';

/**
 * DEC-49 online PDF maker (built, not deployed; off unless PDF_RENDER_ONLINE
 * is "on"). Each call renders at most one queued itinerary job.
 *   GET   Vercel Cron (Authorization: Bearer CRON_SECRET)
 *   POST  manual run (Authorization: Bearer RENDER_WORKER_SECRET)
 * Self-authenticating machine route: /api/integrations/* is outside the
 * staff-session proxy.
 */
// Review E10-7: room for a cold start (Chromium inflates into /tmp) and two
// page loads, below the job's 120 s lease so a slow run never outlives it.
export const maxDuration = 90;

export async function GET(request: Request): Promise<Response> {
  return handleOnlineRenderRequest(request, 'cron', productionOnlineDeps());
}

export async function POST(request: Request): Promise<Response> {
  return handleOnlineRenderRequest(request, 'manual', productionOnlineDeps());
}
