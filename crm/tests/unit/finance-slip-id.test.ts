import { describe, expect, it } from 'vitest';
import { depositSlipRequestId } from '@/modules/finance/server/slip-id';

describe('depositSlipRequestId', () => {
  it('is a stable UUID v5 derived from the deposit request id', () => {
    const a = depositSlipRequestId('11111111-2222-4333-8444-555555555555');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(depositSlipRequestId('11111111-2222-4333-8444-555555555555'.toUpperCase())).toBe(a);
    expect(depositSlipRequestId('66666666-7777-4888-9999-aaaaaaaaaaaa')).not.toBe(a);
    expect(a).not.toBe('11111111-2222-4333-8444-555555555555');
  });
});
