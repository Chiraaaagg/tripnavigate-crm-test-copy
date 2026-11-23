import { handleTimerRequest, productionTimerDeps } from '@/modules/timer/server/run';

/**
 * Timer (Accounts phase 3 contract 5.2, LD1). The database cron job
 * `crm-timer` (created paused; activated only by an approved operator step)
 * posts here once a minute with `Authorization: Bearer TIMER_SECRET` from
 * Vault. POST only (other methods answer 405). Self-authenticating machine
 * route: /api/integrations/* is outside the staff-session proxy, and no staff
 * session can call it. The response carries counts only.
 */
export const maxDuration = 55;

export async function POST(request: Request): Promise<Response> {
  return handleTimerRequest(request, productionTimerDeps());
}
