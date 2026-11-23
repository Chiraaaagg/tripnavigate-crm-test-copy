import { handleResendWebhook, productionWebhookDeps } from '@/modules/customer-messages/server/webhooks';

/**
 * Resend delivery reports for customer e-mails (Accounts phase 3, contract
 * 5.8). POST only. Self-authenticating machine route outside the staff proxy:
 * the Svix signature (RESEND_WEBHOOK_SECRET) is checked on the raw body before
 * anything is parsed or stored; a bad or missing signature answers 401.
 */
export async function POST(request: Request): Promise<Response> {
  return handleResendWebhook(request, productionWebhookDeps('resend'));
}
