import { handleInteraktWebhook, productionWebhookDeps } from '@/modules/customer-messages/server/webhooks';

/**
 * Interakt delivery reports and inbound STOP / START (Accounts phase 3,
 * contract 5.8). POST only. Self-authenticating machine route outside the
 * staff proxy: the Interakt-Signature HMAC (INTERAKT_WEBHOOK_SECRET) is checked
 * on the raw body before anything is parsed or stored; a bad or missing
 * signature answers 401. Inbound text is classified and dropped.
 */
export async function POST(request: Request): Promise<Response> {
  return handleInteraktWebhook(request, productionWebhookDeps('interakt'));
}
