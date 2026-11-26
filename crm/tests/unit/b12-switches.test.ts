import { describe, expect, it } from 'vitest';
import { B12_SWITCH_FIELD, parseB12SwitchForm } from '@/modules/fulfilment/b11-forms';
import { B12_SWITCH_KEYS, B12_SWITCH_TEXT } from '@/modules/fulfilment/contracts';

/** B1.2 switches: form rules and wording (Terra's TS layer). */

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('B1.2 switch form', () => {
  it('known key, on or off, and a reason of 10 to 500 characters (spaces collapsed)', () => {
    expect(parseB12SwitchForm(form({ [B12_SWITCH_FIELD.key]: 'bitrix_id_proof_copy', [B12_SWITCH_FIELD.state]: 'on', [B12_SWITCH_FIELD.reason]: '  Owner   approved today  ' }))).toEqual({
      ok: true,
      value: { key: 'bitrix_id_proof_copy', on: true, reason: 'Owner approved today' },
    });
    expect(parseB12SwitchForm(form({ [B12_SWITCH_FIELD.key]: 'service_items_enabled', [B12_SWITCH_FIELD.state]: 'yes', [B12_SWITCH_FIELD.reason]: 'x'.repeat(501) }))).toEqual({
      ok: false,
      fields: [B12_SWITCH_FIELD.key, B12_SWITCH_FIELD.state, B12_SWITCH_FIELD.reason],
    });
  });

  it('every switch has a title, a detail and on/off words; the copy switch says switching on closes open stops', () => {
    for (const key of B12_SWITCH_KEYS) expect(B12_SWITCH_TEXT[key]).toEqual({ title: expect.any(String), detail: expect.any(String), onNote: expect.any(String), offNote: expect.any(String) });
    expect(B12_SWITCH_TEXT.bitrix_id_proof_copy.detail).toContain('closes any open automatic stops');
  });
});
