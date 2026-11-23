import type { AdminCustomerMessages as AdminDto } from '@/modules/customer-messages/dto';
import { MESSAGE_TYPES, type AdminCustomerMessages, type Language, type MessageType } from './types';

/*
 * Maps track A's R-A2 DTO (`@/modules/customer-messages/dto`) onto the
 * Settings view's adapter shape (contract 5.10). Pure; the route calls it.
 * Template type and language come from the frozen code
 * `tn_<type>_<en|hi>_v<n>`; the preview body is the WhatsApp text.
 */

const CODE = /^tn_([a-z_]+)_(en|hi)_v[0-9]+$/;

export function templateCodeParts(code: string): { type: MessageType; language: Language } | null {
  const m = CODE.exec(code);
  if (!m) return null;
  const type = m[1] as MessageType;
  return (MESSAGE_TYPES as readonly string[]).includes(type) ? { type, language: m[2] as Language } : null;
}

export function adminMessagesView(dto: AdminDto): AdminCustomerMessages {
  return {
    entityId: dto.entityId,
    switches: dto.switches.map((s) => ({ type: s.type, channel: s.channel, enabled: s.enabled, rowVersion: s.rowVersion })),
    pilotOnly: dto.pilotOnly,
    pilot: dto.pilot.map((p) => ({ dealId: p.dealId, dealReference: p.dealReference, addedByName: null, addedAt: p.addedAt })),
    templates: dto.templates.flatMap((t) => {
      const parts = templateCodeParts(t.templateCode);
      return parts ? [{ templateCode: t.templateCode, type: parts.type, language: parts.language, status: t.status, updatedAt: t.updatedAt }] : [];
    }),
    previews: dto.previews.map((p) => ({ type: p.type, language: p.language, subject: p.subject, body: p.whatsappText })),
    timer: { enabled: dto.timer.enabled, lastOkAt: dto.timer.lastOkAt, queueOldestMinutes: dto.timer.queueOldestMinutes, configured: dto.timer.configured },
    providers: dto.providers.map((p) => ({ key: p.key, configured: p.configured })),
  };
}
