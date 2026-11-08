import { describe, expect, it } from 'vitest';
import { BRANCHES, COMPANY_IDENTITY, companyIdentityFor } from '@/modules/documents/company-identity';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { scanStrings } from '@/modules/documents/safety';
import { isPlaceholder } from '@/modules/documents/text';

/** GSTIN check character (GSTN mod-36 scheme over the first 14 characters). */
function gstinCheckChar(first14: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  [...first14].forEach((c, i) => {
    const product = chars.indexOf(c) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  });
  return chars[(36 - (sum % 36)) % 36]!;
}

describe('company identity record (DEC-50)', () => {
  const record = COMPANY_IDENTITY.HOLIDAY_CHACHA;

  it('holds exactly the owner-approved values', () => {
    expect(record.legalName).toBe('Holiday Chacha Pvt Ltd');
    expect(record.registeredAddress).toBe('59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003');
    expect(record.pan).toBe('AAFCH9191M');
    expect(record.gstinByBranch).toEqual({ JDH: '08AAFCH9191M1ZV', DEL: null, AMD: null });
  });

  it('every given GSTIN is well formed, carries the PAN and has a valid check character', () => {
    for (const gstin of Object.values(record.gstinByBranch)) {
      if (gstin === null) continue;
      expect(gstin).toMatch(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);
      expect(gstin.slice(2, 12)).toBe(record.pan);
      expect(gstin[14]).toBe(gstinCheckChar(gstin.slice(0, 14)));
    }
    // Jodhpur is registered in Rajasthan (GST state code 08).
    expect(record.gstinByBranch.JDH?.slice(0, 2)).toBe('08');
  });

  it('is frozen (changes only by a reviewed commit)', () => {
    expect(Object.isFrozen(COMPANY_IDENTITY)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.gstinByBranch)).toBe(true);
    expect(Object.isFrozen(BRANCHES)).toBe(true);
    expect(Object.isFrozen(BRANCHES.JDH)).toBe(true);
  });

  it('branches match the live branch codes and states', () => {
    expect(BRANCHES).toEqual({
      JDH: { name: 'Jodhpur', state: 'Rajasthan' },
      DEL: { name: 'Delhi', state: 'Delhi' },
      AMD: { name: 'Ahmedabad', state: 'Gujarat' },
    });
  });
});

describe('companyIdentityFor', () => {
  it('Jodhpur: complete line, no placeholder', () => {
    const line = companyIdentityFor('JDH');
    expect(line).toEqual({
      legalName: 'Holiday Chacha Pvt Ltd',
      registeredAddress: '59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003',
      pan: 'AAFCH9191M',
      gstin: '08AAFCH9191M1ZV',
      gstinState: 'Rajasthan',
      placeholders: [],
    });
    expect(isPlaceholder(line.gstin)).toBe(false);
  });

  it('Delhi and Ahmedabad: GSTIN not given yet, a visible placeholder that blocks the final document', () => {
    const del = companyIdentityFor('DEL');
    expect(del.gstin).toBe('[GSTIN for Delhi]');
    expect(isPlaceholder(del.gstin)).toBe(true);
    expect(del.gstinState).toBe('Delhi');
    expect(del.placeholders).toEqual(['GSTIN for Delhi']);
    expect(del.pan).toBe('AAFCH9191M');

    const amd = companyIdentityFor('AMD');
    expect(amd.gstin).toBe('[GSTIN for Ahmedabad]');
    expect(amd.gstinState).toBe('Gujarat');
    expect(amd.placeholders).toEqual(['GSTIN for Ahmedabad']);
  });

  it('a missing or unknown branch gives the generic placeholder', () => {
    for (const code of [null, undefined, '', 'XYZ', 'constructor', '__proto__']) {
      const line = companyIdentityFor(code);
      expect(line.gstin).toBe('[GSTIN for branch]');
      expect(line.gstinState).toBeNull();
      expect(line.placeholders).toEqual(['GSTIN for branch']);
      expect(line.legalName).toBe('Holiday Chacha Pvt Ltd');
    }
  });

  it('accepts the code in any case and with spaces', () => {
    expect(companyIdentityFor(' jdh ').gstin).toBe('08AAFCH9191M1ZV');
  });

  it('passes the customer-document safety scan and the forbidden-key rule', () => {
    for (const code of ['JDH', 'DEL', 'AMD', null]) {
      const line = companyIdentityFor(code);
      expect(scanStrings(line)).toEqual([]);
      expect(forbiddenKeyPaths(line)).toEqual([]);
    }
  });
});
