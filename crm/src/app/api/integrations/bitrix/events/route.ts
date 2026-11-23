import { receiveBitrixEvent } from '@/modules/integration/server/runtime';

/**
 * Bitrix24 outbound webhook receiver (contract §6). POST only; other methods get
 * 405 from Next.js. Authenticates, records durably and acknowledges; it never
 * processes the deal inline. Exempt from the staff-session proxy (src/proxy.ts).
 * Sync completion §1: a pending row schedules one bounded live batch with
 * after(), which runs after the 200 answer within this route's maxDuration.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return receiveBitrixEvent(request);
}
