import { describe, expect, it } from 'vitest';
import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';
import { buildMailtoHref, buildSupplierEmailDraft, draftAsText } from '@/modules/procurement/email-draft';
import {
  budgetDelta,
  budgetDeltaText,
  hotelBreakup,
  isEmailShaped,
  lowestPaise,
  routeFor,
  rupeesToPaise,
  splitEmails,
  wholeStayFromPerNight,
} from '@/views/purchase/purchase-vm';

/** Purchase build view helpers (Track C). Synthetic data only. */

const task: PurchaseTaskView = {
  taskId: 't1',
  dealReference: 'SYN-JOD-547',
  serviceType: 'hotel',
  itemTitle: 'Synthetic Fort Retreat, Jaisalmer',
  facts: { type: 'hotel', facts: { hotelName: 'Synthetic Fort Retreat', city: 'Jaisalmer', checkIn: '2026-11-06', checkOut: '2026-11-08', rooms: 4, adults: 8, children: 1, extraBeds: 1, childrenWithoutBed: 2 } },
  hotelName: 'Synthetic Fort Retreat',
  city: 'Jaisalmer',
  checkIn: '2026-11-06',
  checkOut: '2026-11-08',
  nights: 2,
  rooms: 4,
  travellers: { adults: 8, children: 1 },
  purchaseBudgetPaise: '11000000',
  status: 'in_progress',
  assigneeName: 'Synthetic Purchase',
  assignedToYou: true,
  branchName: 'Jodhpur',
  createdAt: '2026-10-22T07:05:00Z',
  roomType: 'Deluxe twin room',
  mealPlan: 'All meals',
  inclusions: null,
  specialRequests: 'Ground floor (synthetic)',
  confirmedAt: '2026-10-22T07:05:00Z',
  confirmedByName: 'Synthetic Sales',
  versionNo: 1,
  canClaim: false,
  estimate: { estimate: { kind: 'hotel', roomRatePaise: '1300000', extraBedRatePaise: '300000', noBedRatePaise: null }, totalPaise: null },
};

describe('hotelBreakup', () => {
  it('lists rooms, extra beds and guests without a bed per night × nights', () => {
    const b = hotelBreakup(task)!;
    expect(b.lines.map((l) => [l.label, l.quantityText, l.totalPaise])).toEqual([
      ['Deluxe twin room', '4 rooms', '10400000'],
      ['Extra bed', '1 bed', '600000'],
      ['Guest without a bed', '2 guests', null],
    ]);
    // A line without a rate makes the total unknown, never a false sum.
    expect(b.totalPaise).toBeNull();
  });

  it('totals when every line has a rate, with the per-night amount', () => {
    const b = hotelBreakup({ ...task, facts: { type: 'hotel', facts: { ...(task.facts.facts as object), childrenWithoutBed: 0 } } as PurchaseTaskView['facts'] })!;
    expect(b.totalPaise).toBe('11000000');
    expect(b.perNightPaise).toBe('5500000');
  });

  it('is null without an estimate, without a room rate, or for a non-hotel task', () => {
    expect(hotelBreakup({ ...task, estimate: undefined })).toBeNull();
    expect(hotelBreakup({ ...task, estimate: { estimate: { kind: 'hotel', roomRatePaise: null, extraBedRatePaise: null, noBedRatePaise: null }, totalPaise: null } })).toBeNull();
    expect(hotelBreakup({ ...task, serviceType: 'transfer' })).toBeNull();
  });
});

describe('rates against the budget', () => {
  it('says under, over or equal in whole rupees', () => {
    expect(budgetDeltaText(budgetDelta('10400000', '11000000'))).toBe('₹6,000 under budget');
    expect(budgetDeltaText(budgetDelta('11200050', '11000000'))).toBe('₹2,000.50 over budget');
    expect(budgetDeltaText(budgetDelta('11000000', '11000000'))).toBe('Equal to the budget');
    expect(budgetDelta('100', '0').kind).toBe('no_budget');
  });

  it('finds the lowest rate and fills the whole stay from a per-night rate', () => {
    expect(lowestPaise(['300', '100', '200'])).toBe('100');
    expect(lowestPaise([])).toBeNull();
    expect(wholeStayFromPerNight('13,000', 4, 2)).toBe('104000.00');
    expect(wholeStayFromPerNight('0', 4, 2)).toBeNull();
    expect(wholeStayFromPerNight('abc', 4, 2)).toBeNull();
  });

  it('routes exactly ₹50,000 to Accounts and above to the branch Manager', () => {
    expect(routeFor(5_000_000n)).toBe('accounts');
    expect(routeFor(5_000_001n)).toBe('manager');
    expect(rupeesToPaise('50,000')).toBe(5_000_000n);
    expect(rupeesToPaise('-5')).toBeNull();
  });
});

describe('supplier e-mail drafts (procurement email-draft.ts, as the drawer uses it)', () => {
  const base = { task, greetingName: 'Example Stays team', senderName: 'Synthetic Purchase' };

  it('subjects carry the kind, Deal ID, service and dates', () => {
    expect(buildSupplierEmailDraft({ ...base, kind: 'rate_request' }).subject).toBe('Rate request · SYN-JOD-547 · Synthetic Fort Retreat, Jaisalmer · 6–8 Nov 2026');
  });

  it('a rate request has no rupee amount; a booking request carries exactly the final cost version amount, never the budget', () => {
    expect(buildSupplierEmailDraft({ ...base, kind: 'rate_request' }).body).not.toMatch(/₹/);
    const booking = buildSupplierEmailDraft({ ...base, kind: 'booking_request', agreedRatePaise: '10400000' }).body;
    expect(booking).toContain('Agreed rate: ₹1,04,000 in total.');
    expect(booking).not.toContain('1,10,000');
    for (const word of ['selling', 'margin']) expect(booking.toLowerCase()).not.toContain(word);
  });

  it('Cc parsing, e-mail shape, mailto and the copied draft', () => {
    expect(splitEmails(' a@x.example, b@y.example;c@z.example ')).toEqual(['a@x.example', 'b@y.example', 'c@z.example']);
    expect(isEmailShaped('desk@hotel.example')).toBe(true);
    expect(isEmailShaped('desk@hotel')).toBe(false);
    expect(buildMailtoHref({ to: 'desk@hotel.example', cc: ['ops@x.example'], subject: 'A', body: 'B' })).toBe('mailto:desk@hotel.example?cc=ops%40x.example&subject=A&body=B');
    expect(draftAsText({ to: 'desk@hotel.example', subject: 'S', body: 'B' })).toBe('To: desk@hotel.example\nSubject: S\n\nB');
  });
});

describe('Home rows from supplier_money_home_counts', () => {
  it('per role, with links to the matching lists; null counts are hidden, never 0', async () => {
    const { supplierMoneyRows, NO_HOME_ROLES } = await import('@/views/home-view');
    const none = Object.fromEntries(
      ['requestsToApprove', 'purchaseTasksNotTaken', 'purchaseWaitingForGoAhead', 'purchaseCostsWaitingForManager', 'paymentRequestsReturned', 'supplierInvoicesMissing', 'goAheadToApprove', 'supplierPaymentsToApprove', 'supplierPaymentsToRecord', 'supplierPaymentsToVerify', 'supplierDocumentsToReview', 'fundingToApprove', 'fundingToRecover', 'managerApprovals'].map((k) => [k, null]),
    ) as never;
    const p = supplierMoneyRows({ ...(none as object), purchaseWaitingForGoAhead: 1, paymentRequestsReturned: 0 } as never, { ...NO_HOME_ROLES, purchase: true });
    expect(p.map((r) => [r.key, r.count, r.href])).toEqual([
      ['purchaseWaitingForGoAhead', 1, '/app/purchase?show=mine'],
      ['paymentRequestsReturned', 0, '/app/purchase/payments?show=returned'],
    ]);
    const m = supplierMoneyRows({ ...(none as object), requestsToApprove: 3 } as never, { ...NO_HOME_ROLES, branchManager: true });
    expect(m.map((r) => [r.label, r.count, r.href])).toEqual([['Waiting for your approval', 3, '/app/approvals']]);
    // Accounts rows never appear for Purchase, and Purchase rows never for Accounts.
    expect(supplierMoneyRows({ ...(none as object), goAheadToApprove: 2 } as never, { ...NO_HOME_ROLES, purchase: true })).toEqual([]);
    expect(supplierMoneyRows({ ...(none as object), goAheadToApprove: 2 } as never, { ...NO_HOME_ROLES, accounts: true }).map((r) => r.href)).toEqual(['/app/accounts/go-ahead']);
  });
});
