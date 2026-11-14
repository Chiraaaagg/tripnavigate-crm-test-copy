import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Stable request id for the proof upload of one payout / supplier refund
 * submission: UUID v5 (RFC 9562) of the command's requestId in a fixed refund
 * namespace (the finance deposit-slip pattern). A retry of the same form
 * replays the same proof begin, then the stored command result.
 */
const NAMESPACE = 'f1a7c0de-5a00-4d3e-8b5a-00000000c0de';

function bytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function refundProofRequestId(commandRequestId: string): string {
  const hash = createHash('sha1')
    .update(Buffer.concat([bytes(NAMESPACE), Buffer.from(`refund-proof:${commandRequestId.toLowerCase()}`, 'utf8')]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
