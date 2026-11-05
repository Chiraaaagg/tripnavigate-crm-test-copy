import { describe, expect, it } from 'vitest';
import type { DealDetail } from '@/modules/deals/dto';
import {
  buildDealHeader,
  buildDealHistory,
  buildDealMoney,
  buildDealOverview,
  buildDealWorkspace,
  canSeeDealMoney,
  dealBookingState,
  dealHistoryGroups,
  dealPrimaryAction,
  dealStatus,
  ownTaskWord,
  parseDealTab,
  toDealDocumentsVM,
  visibleDealTabs,
  type DealBookingInput,
  type DealWorkspaceInput,
} from '@/modules/deals/workspace';
import type { BookNowView, DealServicesView } from '@/modules/fulfilment/contracts';
import { toDealDocumentViews } from '@/modules/deals/documents';
import type { QuotationListView } from '@/modules/quotations/contracts';

/*
 * Batch 1 Deal workspace (DE-02): tab allowlist, the one primary action per
 * state (copy §16.3, DA-20 to DA-31) and the money-privacy rules of the view
 * models (money-privacy-settings.md P5, P6, P12). Synthetic data only.
 */

const DEAL_ID = '00000000-0000-4000-8000-000000000001';
const QV_ID = '00000000-0000-4000-8000-0000000000a1';

const salesDeal: DealDetail = {
  id: DEAL_ID,
  reference: 'BX-9411',
  title: 'Synthetic family, Goa',
  branchName: 'Jodhpur',
  relation: 'owner',
  createdOn: '2026-10-06',
  ownerName: null,
  assignments: [{ kind: 'purchase', isYou: false }],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' },
  source: {
    system: 'bitrix',
    sourceDealId: '9411',
    stageId: 'C2:WON',
    lastSyncedAt: '2026-10-18T10:00:00Z',
    lastVerifiedAt: '2026-10-19T10:00:00Z',
    stale: false,
  },
};
const purchaseDeal: DealDetail = {
  ...salesDeal,
  relation: 'assigned',
  commercial: { visible: false },
  commercialAbsence: 'withheld',
  assignments: [{ kind: 'purchase', isYou: true }],
};

function progress(total: number, confirmed: number) {
  return {
    total,
    byState: { planned: 0, notStarted: total - confirmed, inProgress: 0, supplierConfirmed: confirmed },
    fulfilled: total > 0 && confirmed === total,
    staleCount: 0,
    needs: [],
  };
}

type VersionOver = Partial<NonNullable<BookNowView['version']>>;

function bookView(over: Omit<Partial<BookNowView>, 'version'> & { version?: VersionOver | null } = {}): BookNowView {
  const { version, ...rest } = over;
  const base = { versionId: 'v1', versionNo: 1, status: 'draft', serviceType: 'package', revisesVersionId: null };
  return {
    dealId: DEAL_ID,
    stage: { stageId: 'C2:WON', label: null, isTriggerStage: true },
    dealNotActive: false,
    serviceItemsEnabled: true,
    canEdit: true,
    canOpenRevision: false,
    accountsReview: null,
    checklist: [],
    items: [],
    progress: progress(0, 0),
    ...rest,
    version: version === null || version === undefined ? null : ({ ...base, ...version } as BookNowView['version']),
  } as BookNowView;
}

const blocking = { blocking: true } as BookNowView['checklist'][number];

function input(over: Partial<DealBookingInput> = {}): DealBookingInput {
  return {
    dealId: DEAL_ID,
    book: { state: 'none' },
    legacyBooking: { ok: true, exists: false },
    services: { ok: true, view: null },
    quotations: null,
    ...over,
  };
}

const ok = (view: BookNowView): DealBookingInput['book'] => ({ state: 'ok', view });

const acceptedQuotations: QuotationListView = {
  subjectKind: 'deal',
  subjectId: DEAL_ID,
  canCreate: true,
  quotations: [
    {
      quotationId: 'q1',
      reference: 'TQ-12',
      title: 'Goa',
      subjectKind: 'lead',
      leadId: 'l1',
      dealId: null,
      linkedDealId: DEAL_ID,
      acceptedVersionId: QV_ID,
      converted: false,
      bookingVersionId: null,
      createdAt: '2026-10-10T00:00:00Z',
      rowVersion: 1,
      currentVersionId: QV_ID,
      versions: [
        { versionId: QV_ID, versionNo: 2, status: 'accepted', validUntil: null, sentAt: '2026-10-12T00:00:00Z', acceptedTierKey: 'quoted' },
        { versionId: 'qv1', versionNo: 1, status: 'superseded', validUntil: null, sentAt: null, acceptedTierKey: null },
      ],
    },
  ],
};

describe('Deal tabs: server allowlist (DA-10, Echo E23)', () => {
  it('unknown, repeated or missing ?tab values render Overview', () => {
    for (const raw of [undefined, '', 'nope', 'MONEY', ['money', 'history'], 7, null]) expect(parseDealTab(raw)).toBe('overview');
  });

  it('a tab the viewer may not open renders Overview, never an error that reveals it', () => {
    const visible = visibleDealTabs({ money: false, quotations: false, documents: false });
    expect(visible).toEqual(['overview', 'services', 'history']);
    expect(parseDealTab('money', visible)).toBe('overview');
    expect(parseDealTab('quotations', visible)).toBe('overview');
    expect(parseDealTab('documents', visible)).toBe('overview');
    expect(parseDealTab('history', visible)).toBe('history');
  });

  it('lists tabs in DA-10 order; Money only for price readers, Documents only when the read exists', () => {
    expect(visibleDealTabs({ money: true, quotations: true, documents: true })).toEqual(['overview', 'services', 'quotations', 'documents', 'money', 'history']);
    expect(visibleDealTabs({ money: true, quotations: true, documents: false })).not.toContain('documents');
    expect(canSeeDealMoney(salesDeal)).toBe(true);
    expect(canSeeDealMoney({ commercialAbsence: 'not_recorded' })).toBe(true);
    expect(canSeeDealMoney(purchaseDeal)).toBe(false);
  });
});

describe('one primary action per Deal state (copy §16.3)', () => {
  const cases: Array<{
    id: string;
    input: DealBookingInput;
    state: string;
    word: string;
    primary: { kind: string; label: string; href?: string } | null;
    next: string;
  }> = [
    {
      id: 'DA-20',
      input: input({ book: ok(bookView()) }),
      state: 'not_started',
      word: 'Not started',
      primary: { kind: 'start_booking', label: 'Start booking' },
      next: 'start the booking',
    },
    {
      id: 'DA-21',
      input: input({ book: ok(bookView({ canEdit: false })) }),
      state: 'not_started',
      word: 'Not started',
      primary: null,
      next: 'Sales on this deal or the branch Manager starts the booking',
    },
    {
      id: 'DA-22',
      input: input({ book: ok(bookView()), quotations: acceptedQuotations }),
      state: 'quotation_accepted',
      word: 'Quotation accepted',
      primary: { kind: 'start_from_quotation', label: 'Start booking from quotation', href: `/app/quotations/${QV_ID}` },
      next: 'start the booking from quotation TQ-12',
    },
    {
      id: 'DA-23',
      input: input({ book: ok(bookView({ version: { status: 'draft' }, checklist: [blocking, blocking] })) }),
      state: 'in_progress',
      word: 'Booking in progress',
      primary: { kind: 'continue_booking', label: 'Continue booking', href: `/app/deals/${DEAL_ID}/book` },
      next: 'finish 2 things',
    },
    {
      id: 'DA-24',
      input: input({ book: ok(bookView({ version: { status: 'draft' } })) }),
      state: 'ready_to_submit',
      word: 'Ready to submit',
      primary: { kind: 'review_and_submit', label: 'Review and submit', href: `/app/deals/${DEAL_ID}/book/finish#review` },
      next: 'review and submit (step 3)',
    },
    {
      id: 'DA-25',
      input: input({ book: ok(bookView({ version: { status: 'confirmed' }, accountsReview: { status: 'pending', reviewedAt: null, reason: null, reasonHidden: false } })) }),
      state: 'waiting_for_accounts',
      word: 'Waiting for Accounts',
      primary: { kind: 'view_booking', label: 'View booking', href: `/app/deals/${DEAL_ID}/book` },
      next: 'Accounts checks the booking',
    },
    {
      id: 'DA-26',
      input: input({
        book: ok(bookView({ version: { status: 'confirmed' }, canOpenRevision: true, accountsReview: { status: 'returned', reviewedAt: null, reason: 'Fix the dates', reasonHidden: false } })),
      }),
      state: 'returned',
      word: 'Returned by Accounts',
      primary: { kind: 'fix_and_send_again', label: 'Fix and send again', href: `/app/deals/${DEAL_ID}/book` },
      next: 'fix what Accounts asked for',
    },
    {
      id: 'DA-27',
      input: input({
        book: ok(
          bookView({
            version: { status: 'confirmed' },
            accountsReview: { status: 'approved', reviewedAt: null, reason: null, reasonHidden: false },
            progress: progress(2, 1),
            items: [
              { department: 'purchase', state: 'active', task: { status: 'in_progress' } },
              { department: 'flight', state: 'active', task: { status: 'supplier_confirmed' } },
            ] as unknown as BookNowView['items'],
          }),
        ),
      }),
      state: 'being_arranged',
      word: 'Being arranged',
      primary: { kind: 'see_team_tasks', label: 'See team tasks', href: `/app/deals/${DEAL_ID}?tab=services` },
      next: 'Purchase arrange the services. Nothing is booked until the supplier confirms.',
    },
    {
      id: 'DA-28',
      input: input({
        book: ok(bookView({ version: { status: 'confirmed' }, accountsReview: { status: 'approved', reviewedAt: null, reason: null, reasonHidden: false }, progress: progress(2, 2) })),
      }),
      state: 'all_confirmed',
      word: 'All services confirmed',
      primary: { kind: 'view_booking', label: 'View booking', href: `/app/deals/${DEAL_ID}/book` },
      next: 'Nothing waiting.',
    },
    {
      id: 'DA-29 with a booking',
      input: input({ book: ok(bookView({ dealNotActive: true, canEdit: false, version: { status: 'draft' } })) }),
      state: 'lost',
      word: 'Lost in Bitrix',
      primary: { kind: 'view_booking', label: 'View booking', href: `/app/deals/${DEAL_ID}/book` },
      next: 'nothing while the deal is lost or rejected in Bitrix',
    },
    {
      id: 'DA-29 without a booking',
      input: input({ book: ok(bookView({ dealNotActive: true })) }),
      state: 'lost',
      word: 'Lost in Bitrix',
      primary: null,
      next: 'nothing while the deal is lost or rejected in Bitrix',
    },
    {
      id: 'DA-30',
      input: input({ book: ok(bookView({ version: { serviceType: 'hotel', status: 'confirmed' } })), legacyBooking: { ok: true, exists: true } }),
      state: 'hotel_legacy',
      word: 'Hotel booking',
      primary: { kind: 'open_hotel_booking', label: 'Open hotel booking', href: `/app/deals/${DEAL_ID}?tab=services#hotel-booking` },
      next: 'see the hotel booking under Services and tasks',
    },
    {
      id: 'DA-31',
      input: input({ book: { state: 'failed' } }),
      state: 'could_not_load',
      word: 'Could not load',
      primary: null,
      next: 'Booking did not load. Nothing was changed. Reload the page.',
    },
  ];

  for (const c of cases) {
    it(`${c.id}: ${c.word}`, () => {
      const state = dealBookingState(c.input);
      expect(state).toBe(c.state);
      expect(dealStatus(c.input)?.word).toBe(c.word);
      const action = dealPrimaryAction(c.input);
      if (c.primary === null) expect(action.primary).toBeNull();
      else expect(action.primary).toMatchObject(c.primary);
      expect(action.next.text).toBe(c.next);
    });
  }

  it('a failed Book now read is never "Not started", even with services and a legacy panel', () => {
    const state = dealBookingState(input({ book: { state: 'failed' }, legacyBooking: { ok: true, exists: true } }));
    expect(state).toBe('could_not_load');
  });

  it('a lost Deal never offers an editing action', () => {
    for (const v of [null, { status: 'draft' as const }, { status: 'confirmed' as const }]) {
      const action = dealPrimaryAction(input({ book: ok(bookView({ dealNotActive: true, version: v })) }));
      expect(['view_booking', undefined]).toContain(action.primary?.kind);
    }
  });

  it('DA-22 without the right to start: no primary, the Next line names who acts', () => {
    const action = dealPrimaryAction(input({ book: ok(bookView({ canEdit: false })), quotations: acceptedQuotations }));
    expect(action.primary).toBeNull();
    expect(action.next.text).toContain('TQ-12');
  });

  it('non-actor Next lines name who may act (copy §16.10 DA-21a, DA-113; lead ruling on the fix predicate)', () => {
    const quote = dealPrimaryAction(input({ book: ok(bookView({ canEdit: false })), quotations: acceptedQuotations }));
    expect(quote.next.text).toBe('Sales on this deal or the branch Manager starts the booking from quotation TQ-12');
    const draft = dealPrimaryAction(input({ book: ok(bookView({ canEdit: false, version: { status: 'draft' }, checklist: [blocking] })) }));
    expect(draft).toEqual({ primary: null, next: { text: 'Sales on this deal or the branch Manager finishes the booking' } });
    // Submitting needs can_confirm_booking (owner or branch Manager only): that line keeps the owner wording.
    const ready = dealPrimaryAction(input({ book: ok(bookView({ canEdit: false, version: { status: 'draft' } })) }));
    expect(ready.next.text).toBe('the deal owner or branch Manager reviews and submits the booking');
    // Opening a fix uses can_edit_booking_draft (assigned Sales too).
    const returned = dealPrimaryAction(
      input({ book: ok(bookView({ version: { status: 'confirmed' }, canOpenRevision: false, accountsReview: { status: 'returned', reviewedAt: null, reason: null, reasonHidden: true } })) }),
    );
    expect(returned.next.text).toBe('Sales on this deal or the branch Manager fixes what Accounts asked for');
  });

  it('a converted quotation does not offer to start again', () => {
    const converted: QuotationListView = { ...acceptedQuotations, quotations: [{ ...acceptedQuotations.quotations[0]!, converted: true, bookingVersionId: 'bv1' }] };
    expect(dealBookingState(input({ book: ok(bookView()), quotations: converted }))).toBe('not_started');
  });

  it('a returned booking without the revision right falls back to reading it', () => {
    const view = bookView({ version: { status: 'confirmed' }, canOpenRevision: false, accountsReview: { status: 'returned', reviewedAt: null, reason: null, reasonHidden: true } });
    expect(dealPrimaryAction(input({ book: ok(view) })).primary?.kind).toBe('view_booking');
  });

  describe('viewers without a Book now view: only what their reads prove (lead ruling 2)', () => {
    type Task = { department: 'purchase' | 'flight' | 'visa'; status: 'not_started' | 'in_progress' | 'supplier_confirmed' | 'completed'; mine: boolean };
    const services = (status: 'draft' | 'confirmed' | null, tasks: Task[] = [], fulfilled = false, serviceType: 'hotel' | 'package' = 'package') =>
      ({
        version: status ? { status, serviceType } : null,
        items: tasks.map((t, i) => ({ itemNo: i + 1, department: t.department, state: 'active', task: { status: t.status, assignedToYou: t.mine } })),
        progress: progress(Math.max(tasks.length, 1), fulfilled ? Math.max(tasks.length, 1) : 0),
      }) as unknown as DealServicesView;
    const limited = (view: DealServicesView | null) => input({ services: { ok: true, view } });
    const NOT_PROVABLE = ['Being arranged', 'All services confirmed', 'Waiting for Accounts', 'Returned by Accounts', 'Lost in Bitrix', 'Not started'];

    it('Purchase assignee: the word of their own task, and the team tasks link', () => {
      const i = limited(services('confirmed', [{ department: 'purchase', status: 'in_progress', mine: true }]));
      expect(dealStatus(i)).toEqual({ state: 'own_task', word: 'In progress' });
      expect(dealPrimaryAction(i)).toEqual({
        primary: { kind: 'see_team_tasks', label: 'See team tasks', href: `/app/deals/${DEAL_ID}?tab=services` },
        next: { text: 'see Services and tasks' },
      });
    });

    it('DA-44 words per department; the least advanced own task wins', () => {
      expect(ownTaskWord(services('confirmed', [{ department: 'purchase', status: 'not_started', mine: true }]))).toBe('Waiting to be taken');
      expect(ownTaskWord(services('confirmed', [{ department: 'purchase', status: 'supplier_confirmed', mine: true }]))).toBe('Confirmed by supplier');
      expect(ownTaskWord(services('confirmed', [{ department: 'flight', status: 'supplier_confirmed', mine: true }]))).toBe('Confirmed by supplier');
      expect(ownTaskWord(services('confirmed', [{ department: 'visa', status: 'completed', mine: true }]))).toBe('Completed');
      expect(
        ownTaskWord(
          services('confirmed', [
            { department: 'flight', status: 'supplier_confirmed', mine: true },
            { department: 'flight', status: 'in_progress', mine: true },
          ]),
        ),
      ).toBe('In progress');
      // Someone else's task is not "own".
      expect(ownTaskWord(services('confirmed', [{ department: 'purchase', status: 'in_progress', mine: false }]))).toBeNull();
    });

    it('Purchase or Flight holder without an own task: "Booking submitted", never "Being arranged" or "All services confirmed"', () => {
      for (const fulfilled of [false, true]) {
        const i = limited(services('confirmed', [{ department: 'purchase', status: 'supplier_confirmed', mine: false }], fulfilled));
        expect(dealStatus(i)).toEqual({ state: 'submitted', word: 'Booking submitted' });
        expect(dealPrimaryAction(i).primary?.kind).toBe('see_team_tasks');
      }
    });

    it('Accounts (no task rows): a submitted version is "Booking submitted" with no primary', () => {
      const i = limited(services('confirmed'));
      expect(dealStatus(i)?.word).toBe('Booking submitted');
      expect(dealPrimaryAction(i)).toEqual({ primary: null, next: { text: 'see Services and tasks' } });
    });

    it('a readable draft is "Booking in progress" with no action', () => {
      const i = limited(services('draft'));
      expect(dealStatus(i)?.word).toBe('Booking in progress');
      expect(dealPrimaryAction(i).primary).toBeNull();
    });

    it('nothing readable: no status word, Next says "see Services and tasks"', () => {
      for (const view of [null, services(null)]) {
        expect(dealBookingState(limited(view))).toBeNull();
        expect(dealStatus(limited(view))).toBeUndefined();
        expect(dealPrimaryAction(limited(view))).toEqual({ primary: null, next: { text: 'see Services and tasks' } });
        const header = buildDealHeader({ ...limited(view), deal: purchaseDeal, leadLink: null });
        expect(header).not.toHaveProperty('status');
        expect(header.next).toEqual({ text: 'see Services and tasks' });
      }
    });

    it('a lost Bitrix stage code alone never makes a lost claim (the list is only in the database)', () => {
      const lostDeal: DealDetail = { ...purchaseDeal, source: { ...purchaseDeal.source!, stageId: 'C1:LOSE' } };
      const header = buildDealHeader({ ...limited(services('confirmed')), deal: lostDeal, leadLink: null });
      expect(header.lostInBitrix).toBe(false);
      expect(header.status?.word).toBe('Booking submitted');
    });

    it('never a booking link and never an unprovable word, in any combination', () => {
      const views = [
        null,
        services('draft'),
        services('confirmed'),
        services('confirmed', [], true),
        services('confirmed', [{ department: 'purchase', status: 'in_progress', mine: false }], true),
        services('confirmed', [{ department: 'visa', status: 'completed', mine: true }], true),
      ];
      for (const view of views) {
        const action = dealPrimaryAction(limited(view));
        expect([undefined, 'see_team_tasks']).toContain(action.primary?.kind);
        expect(JSON.stringify(action)).not.toContain('/book');
        expect(NOT_PROVABLE).not.toContain(dealStatus(limited(view))?.word);
      }
    });

    it('a failed services or legacy read is "Could not load"', () => {
      expect(dealBookingState(input({ services: { ok: false } }))).toBe('could_not_load');
      expect(dealBookingState(input({ legacyBooking: { ok: false } }))).toBe('could_not_load');
    });

    it('an older hotel version they can read stays "Hotel booking"', () => {
      expect(dealStatus(limited(services('confirmed', [], false, 'hotel')))?.word).toBe('Hotel booking');
    });
  });
});

describe('header (no money)', () => {
  it('DA-20 chip only with the start action and a non-Won stage; stage shows the switched-off fallback', () => {
    const header = buildDealHeader({ ...input({ book: ok(bookView({ stage: { stageId: 'C2:NEW', label: null, isTriggerStage: false } })) }), deal: salesDeal, leadLink: null });
    expect(header.waitsForWon).toBe(true);
    expect(header.stage).toEqual({ code: 'C2:WON', name: null, labelState: 'switched_off' });
    expect(header.owner).toEqual({ kind: 'you' });
    expect(header.testRecord).toBe(false);
    expect('leadLink' in header).toBe(false);
  });

  it('carries the return reason only when shared with Sales', () => {
    const view = bookView({ version: { status: 'confirmed' }, accountsReview: { status: 'returned', reviewedAt: '2026-10-18T00:00:00Z', reason: 'secret', reasonHidden: true } });
    const header = buildDealHeader({ ...input({ book: ok(view) }), deal: salesDeal, leadLink: null });
    expect(header.returnNotice).toEqual({ reviewedAt: '2026-10-18T00:00:00Z', reason: null, reasonHidden: true });
    expect(JSON.stringify(header)).not.toContain('secret');
  });

  it('never carries an amount, even for a price reader', () => {
    const header = buildDealHeader({ ...input({ book: ok(bookView()) }), deal: salesDeal, leadLink: { href: '/app/leads/x', reference: 'BXL-1' } });
    expect(JSON.stringify(header)).not.toMatch(/₹|selling|margin/i);
    expect(header.leadLink).toEqual({ href: '/app/leads/x', reference: 'BXL-1' });
  });

  it('a synthetic record is a test record without a stage', () => {
    const header = buildDealHeader({ ...input(), deal: { ...salesDeal, source: undefined }, leadLink: null });
    expect(header.testRecord).toBe(true);
    expect('stage' in header).toBe(false);
  });
});

describe('overview (no money)', () => {
  it('team words, trip line and travellers, never amounts', () => {
    const services = {
      trip: { destination: 'Goa', scope: 'domestic', start: '2026-11-12', end: '2026-11-15' },
      travellers: [{}, {}],
    } as unknown as DealServicesView;
    const overview = buildDealOverview(salesDeal, services);
    expect(overview.team).toEqual([{ kindLabel: 'Purchase', isYou: false }]);
    expect(overview.tripText).toBe('Goa · 12 Nov 2026 to 15 Nov 2026');
    expect(overview.travellersText).toBe('2 travellers');
    expect(overview.bitrix?.lastCheckedAt).toBe('2026-10-19T10:00:00Z');
    expect(JSON.stringify(overview)).not.toMatch(/₹|selling|margin/i);
  });

  it('unknown trip and travellers stay null (Purchase and Flight get no traveller list)', () => {
    const overview = buildDealOverview(purchaseDeal, { trip: null } as unknown as DealServicesView);
    expect(overview.tripText).toBeNull();
    expect(overview.travellersText).toBeNull();
  });
});

const salesClaims = {
  dealId: DEAL_ID,
  sellingTotalPaise: '10000000',
  reportedPaise: '2000000',
  confirmedPaise: '1000000',
  balancePaise: '9000000',
  canReport: true,
  reportBlock: null,
  destinations: [{ versionId: 'dv1', kind: 'bank', label: 'Synthetic Bank', bankName: 'Synthetic Bank', accountMasked: 'XX1234', upiMasked: null }],
  claims: [
    {
      claimId: 'c1',
      status: 'reported',
      displayStatus: 'reported',
      amountPaise: '2000000',
      mode: 'cheque',
      reference: 'REF-SECRET',
      chequeNumber: 'CHQ-SECRET',
      chequeDate: '2026-10-10',
      paidOn: '2026-10-10',
      payerName: 'PAYER-SECRET',
      note: 'NOTE-SECRET',
      destinationLabel: 'DEST-SECRET',
      receiptAmountPaise: '77777',
      notReceivedReason: null,
      reportedByName: 'NAME-SECRET',
      reportedAt: '2026-10-10T05:00:00Z',
      rowVersion: 1,
      canWithdraw: true,
    },
  ],
} as unknown as NonNullable<BookNowView['claims']>;

const history = [
  {
    versionId: 'v2',
    versionNo: 2,
    status: 'confirmed',
    confirmedAt: '2026-10-15T00:00:00Z',
    revisesVersionId: 'v1',
    changeClass: 'customer_material',
    changedFields: [],
    reviewStatus: 'returned',
    reviewReason: 'Shared reason',
    reviewReasonHidden: false,
    supersededAt: null,
    sellingTotalPaise: '10000000',
    sellingTotalDeltaPaise: '500000',
  },
  {
    versionId: 'v1',
    versionNo: 1,
    status: 'superseded',
    confirmedAt: '2026-10-12T00:00:00Z',
    revisesVersionId: null,
    changeClass: null,
    changedFields: [],
    reviewStatus: 'returned',
    reviewReason: 'Hidden reason',
    reviewReasonHidden: true,
    supersededAt: '2026-10-15T00:00:00Z',
    sellingTotalPaise: '9500000',
  },
] as unknown as NonNullable<BookNowView['history']>;

describe('Money tab model (the only model with amounts)', () => {
  it('is undefined for a withheld viewer, whatever the booking read carried', () => {
    const view = bookView({ commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: '10000000' }, claims: salesClaims, history });
    expect(buildDealMoney(purchaseDeal, view)).toBeUndefined();
  });

  it('copies exactly the Sales figures: deal value, final total, plan, claims summary, own claims, version totals', () => {
    const view = bookView({
      commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: '10000000' },
      plan: [{ seq: 1, label: 'Advance', amountPaise: '2500000', dueDate: '2026-11-01' }],
      claims: salesClaims,
      history,
    });
    const money = buildDealMoney(salesDeal, view)!;
    expect(money.dealValue).toEqual({ state: 'shown', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' });
    expect(money.booking).toEqual({ finalSellingTotal: '₹1,00,000.00', plan: [{ label: 'Advance', amount: '₹25,000.00', dueDate: '2026-11-01' }] });
    expect(money.claims).toEqual({
      reported: '₹20,000.00',
      confirmed: '₹10,000.00',
      balance: '₹90,000.00',
      own: [{ claimId: 'c1', amount: '₹20,000.00', paidOn: '2026-10-10', mode: 'cheque', status: 'reported' }],
    });
    expect(money.versionTotals).toEqual([
      { versionNo: 2, sellingTotal: '₹1,00,000.00', sellingTotalDelta: '+₹5,000.00' },
      { versionNo: 1, sellingTotal: '₹95,000.00', sellingTotalDelta: null },
    ]);
    // Never destinations, receipt amounts, cheque numbers, payer names, references or Accounts names.
    expect(JSON.stringify(money)).not.toMatch(/SECRET|Synthetic Bank|XX1234|777/);
  });

  it('no commercial row is "not recorded", never zero', () => {
    const money = buildDealMoney({ ...salesDeal, commercial: { visible: false }, commercialAbsence: 'not_recorded' }, null)!;
    expect(money).toEqual({ dealValue: { state: 'not_recorded' } });
  });
});

describe('History tab model (money-free)', () => {
  const quotations = acceptedQuotations;

  it('has no amount and no payment events for a viewer without claims', () => {
    const withoutMoney = history.map((h) => {
      const copy: Record<string, unknown> = { ...h };
      delete copy.sellingTotalPaise;
      delete copy.sellingTotalDeltaPaise;
      return copy;
    });
    const view = bookView({ history: withoutMoney as unknown as BookNowView['history'] });
    const h = buildDealHistory({ book: ok(view), quotations, money: undefined });
    expect(h.state).toBe('ok');
    expect(JSON.stringify(h)).not.toMatch(/₹|Paise|amount/i);
    expect(h.state === 'ok' && h.events.some((e) => e.kind === 'payment_reported')).toBe(false);
  });

  it('even with commercial history rows, the History model carries no amount', () => {
    const view = bookView({ history, claims: salesClaims });
    const money = buildDealMoney(salesDeal, view);
    const h = buildDealHistory({ book: ok(view), quotations, money });
    expect(JSON.stringify(h)).not.toMatch(/₹|10000000|20000|Paise/);
    if (h.state !== 'ok') throw new Error('expected ok');
    expect(h.events.filter((e) => e.kind === 'payment_reported')).toEqual([{ kind: 'payment_reported', id: 'c1', at: '2026-10-10T05:00:00Z', status: 'reported' }]);
  });

  it('booking versions newest first, each followed by its review; hidden reasons stay hidden', () => {
    const h = buildDealHistory({ book: ok(bookView({ history })), quotations: null, money: undefined });
    if (h.state !== 'ok') throw new Error('expected ok');
    expect(h.events.map((e) => `${e.kind}:${e.id}`)).toEqual(['booking_version:v2', 'accounts_review:v2:review', 'booking_version:v1', 'accounts_review:v1:review']);
    expect(h.events[0]).toMatchObject({ statusText: 'Submitted', at: '2026-10-15T00:00:00Z' });
    expect(h.events[1]).toMatchObject({ reason: 'Shared reason', reasonHidden: false });
    expect(h.events[3]).toMatchObject({ reason: null, reasonHidden: true });
    expect(JSON.stringify(h)).not.toContain('Hidden reason');
  });

  it('quotation versions use DA-41 words and link to the quotation page', () => {
    const h = buildDealHistory({ book: { state: 'none' }, quotations, money: undefined });
    if (h.state !== 'ok') throw new Error('expected ok');
    expect(h.events).toEqual([
      { kind: 'quotation_version', id: QV_ID, at: '2026-10-12T00:00:00Z', quotationReference: 'TQ-12', versionNo: 2, statusText: 'Accepted', href: `/app/quotations/${QV_ID}` },
      { kind: 'quotation_version', id: 'qv1', at: null, quotationReference: 'TQ-12', versionNo: 1, statusText: 'Replaced by v2', href: '/app/quotations/qv1' },
    ]);
  });

  it('a failed booking read is an error, never an empty history; nothing readable is an honest empty list', () => {
    expect(buildDealHistory({ book: { state: 'failed' }, quotations: null, money: undefined })).toEqual({ state: 'error' });
    expect(buildDealHistory({ book: { state: 'none' }, quotations: null, money: undefined })).toEqual({ state: 'ok', events: [] });
  });
});

describe('History groups (lead ruling 5)', () => {
  it('every shown group has a heading and at least one event; empty groups are left out', () => {
    const view = bookView({ history, claims: salesClaims });
    const h = buildDealHistory({ book: ok(view), quotations: acceptedQuotations, money: buildDealMoney(salesDeal, view) });
    if (h.state !== 'ok') throw new Error('expected ok');
    const groups = dealHistoryGroups(h.events);
    expect(groups.map((g) => [g.key, g.heading, g.events.length])).toEqual([
      ['booking', 'Booking versions and Accounts reviews', 4],
      ['quotations', 'Quotations', 2],
      ['payments', 'Reported payments', 1],
    ]);
    expect(dealHistoryGroups([])).toEqual([]);
    const onlyQuotes = buildDealHistory({ book: { state: 'none' }, quotations: acceptedQuotations, money: undefined });
    expect(onlyQuotes.state === 'ok' && dealHistoryGroups(onlyQuotes.events).map((g) => g.key)).toEqual(['quotations']);
  });
});

describe('documents rows (Atlas B1-2 rows, Atlas hrefs)', () => {
  const FILE = '00000000-0000-4000-8000-0000000000f1';
  const parsed = toDealDocumentViews({
    files: [
      { kind: 'booking_file', id: FILE, fileName: 'ticket.pdf', mime: 'application/pdf', uploadedAt: '2026-10-10T00:00:00Z', context: { versionNo: null, evidenceKind: 'ticket' } },
      { kind: 'id_proof', id: FILE, fileName: 'id.jpg', mime: 'image/jpeg', uploadedAt: '2026-10-10T00:00:00Z', context: { travellerSeq: 2 } },
    ],
  })!;

  it('copies rows and the existing-route links unchanged; a null version stays null', () => {
    const vm = toDealDocumentsVM(parsed);
    expect(vm).toEqual({
      state: 'ok',
      rows: [
        { kind: 'booking_file', id: FILE, fileName: 'ticket.pdf', mime: 'application/pdf', uploadedAt: '2026-10-10T00:00:00Z', context: { versionNo: null, evidenceKind: 'ticket' }, href: `/app/bookings/evidence/${FILE}` },
        { kind: 'id_proof', id: FILE, fileName: 'id.jpg', mime: 'image/jpeg', uploadedAt: '2026-10-10T00:00:00Z', context: { travellerSeq: 2 }, href: `/app/id-proofs/${FILE}` },
      ],
    });
    expect(JSON.stringify(vm)).not.toMatch(/storage|object_path|supabase\.co/);
  });

  it('a failed read is an error, never an empty list', () => {
    expect(toDealDocumentsVM('error')).toEqual({ state: 'error' });
    expect(toDealDocumentsVM([])).toEqual({ state: 'ok', rows: [] });
  });
});

describe('whole workspace', () => {
  function ws(deal: DealDetail, tab: unknown, over: Partial<DealWorkspaceInput> = {}) {
    const view = bookView({ commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: '10000000' }, claims: salesClaims, history });
    return buildDealWorkspace({ ...input({ book: ok(view), quotations: acceptedQuotations }), deal, leadLink: null, tab, itinerariesReadable: false, ...over });
  }

  it('Purchase: ?tab=money renders Overview, no Money tab, no amount anywhere in the model', () => {
    const vm = buildDealWorkspace({ ...input(), deal: purchaseDeal, leadLink: null, tab: 'money', itinerariesReadable: false });
    expect(vm.current).toBe('overview');
    expect(vm.tabs.map((t) => t.tab)).toEqual(['overview', 'services', 'history']);
    expect('money' in vm).toBe(false);
    expect(JSON.stringify(vm)).not.toMatch(/₹|selling|margin|Paise/i);
  });

  it('Purchase: History is an honest, money-free model', () => {
    const vm = buildDealWorkspace({ ...input(), deal: purchaseDeal, leadLink: null, tab: 'history', itinerariesReadable: false });
    expect(vm.history).toEqual({ state: 'ok', events: [] });
    expect(JSON.stringify(vm)).not.toMatch(/₹/);
  });

  it('Sales price reader: Money only when the Money tab is open; other tab models left out', () => {
    const overview = ws(salesDeal, undefined);
    expect(overview.current).toBe('overview');
    expect(overview.overview).toBeDefined();
    expect('money' in overview).toBe(false);
    expect('history' in overview).toBe(false);
    expect(JSON.stringify(overview)).not.toMatch(/₹/);
    const money = ws(salesDeal, 'money');
    expect(money.current).toBe('money');
    expect(money.money?.dealValue.state).toBe('shown');
    expect('overview' in money).toBe(false);
    expect(money.tabs.find((t) => t.current)).toEqual({ tab: 'money', label: 'Money', href: `/app/deals/${DEAL_ID}?tab=money`, current: true });
    expect(money.tabs[0]).toEqual({ tab: 'overview', label: 'Overview', href: `/app/deals/${DEAL_ID}`, current: false });
  });

  it('Quotations tab only when a quotation or itinerary list was readable; Documents hidden until B1-2', () => {
    expect(ws(salesDeal, 'quotations', { quotations: null }).current).toBe('overview');
    expect(ws(salesDeal, 'quotations', { quotations: null, itinerariesReadable: true }).current).toBe('quotations');
    expect(ws(salesDeal, 'documents').current).toBe('overview');
    const docs = ws(salesDeal, 'documents', { documentsAvailable: true, documents: [] });
    expect(docs.current).toBe('documents');
    expect(docs.documents).toEqual({ state: 'ok', rows: [] });
  });
});
