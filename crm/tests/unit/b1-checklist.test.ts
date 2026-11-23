import { describe, expect, it } from 'vitest';
import { IntakeChecklistSchema } from '@/modules/fulfilment/commands';
import { CHECKLIST_TEXT, INTAKE_CHECKLIST_CODES } from '@/modules/fulfilment/contracts';
import { checklistText } from '@/modules/fulfilment/dto';

/** Checklist rules live in the database (contract §9); this side maps codes to frozen wording. */

describe('checklistText', () => {
  it('has frozen wording for every code', () => {
    for (const code of INTAKE_CHECKLIST_CODES) {
      expect(checklistText({ code, itemNos: [] })).toBe(CHECKLIST_TEXT[code]);
      expect(CHECKLIST_TEXT[code].length).toBeGreaterThan(10);
    }
  });

  it('names the services an item-level rule applies to', () => {
    expect(checklistText({ code: 'dates_outside_trip', itemNos: [2, 4] })).toBe(`${CHECKLIST_TEXT.dates_outside_trip} (service 2, 4)`);
    expect(checklistText({ code: 'budget_missing', itemNos: [1] })).toBe(`${CHECKLIST_TEXT.budget_missing} (service 1)`);
  });
});

describe('IntakeChecklistSchema', () => {
  it('accepts the database shape and defaults missing itemNos to []', () => {
    const parsed = IntakeChecklistSchema.parse({
      items: [
        { code: 'stage_not_confirmed', blocking: true, owner: 'bitrix' },
        { code: 'budget_missing', blocking: false, owner: 'sales', itemNos: [3] },
      ],
      canConfirm: false,
    });
    expect(parsed.items[0]!.itemNos).toEqual([]);
    expect(parsed.items[1]!.itemNos).toEqual([3]);
  });

  it('drops unknown codes (a newer database must not break the page); refuses unknown owners and item numbers', () => {
    const parsed = IntakeChecklistSchema.safeParse({ items: [{ code: 'ai_suggestion', blocking: true, owner: 'sales' }, { code: 'no_services', blocking: true, owner: 'sales' }], canConfirm: true });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.items.map((i) => i.code)).toEqual(['no_services']);
    expect(IntakeChecklistSchema.safeParse({ items: [{ code: 'no_services', blocking: true, owner: 'purchase' }], canConfirm: true }).success).toBe(false);
    expect(IntakeChecklistSchema.safeParse({ items: [{ code: 'no_services', blocking: true, owner: 'sales', itemNos: [21] }], canConfirm: true }).success).toBe(false);
  });
});
