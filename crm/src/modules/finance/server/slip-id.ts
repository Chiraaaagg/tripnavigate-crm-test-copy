import { createHash } from 'node:crypto';

/**
 * Stable request id for the deposit slip upload of one deposit submission:
 * UUID v5 (RFC 9562) of the deposit's requestId in a fixed finance namespace.
 * A retry of the same deposit form therefore replays the same slip begin, so a
 * committed deposit returns its stored result instead of a second slip.
 */
const NAMESPACE = 'f1a7c0de-5a00-4d3e-8b5a-0000000000a5';

function bytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function depositSlipRequestId(depositRequestId: string): string {
  const hash = createHash('sha1')
    .update(Buffer.concat([bytes(NAMESPACE), Buffer.from(`deposit-slip:${depositRequestId.toLowerCase()}`, 'utf8')]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
