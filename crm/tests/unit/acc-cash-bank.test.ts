import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  CashBranchView,
  CashOverview,
  CompanyDestinationsPage,
  CompanyDestinationView,
  DestinationVersionView,
  FinancePolicyView,
  UnresolvedCashKind,
} from '@/modules/finance/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { cashBranchHasWork, cashBranchHref, CashOverviewView, pickCashBranch } from '@/views/finance-cash-views';
import { CompanyDestinationsView, destinationNextStep, destinationTargetId } from '@/views/finance-destination-views';
import type { FinanceAction, FinanceActions } from '@/views/finance-forms';

/**
 * UX redesign R4, helper A4 (A8 Cash and bank): which branch tab Branch cash
 * shows, the branch tab addresses, the "Next step" of each company account,
 * and that the pages render their tabs and top buttons. Pure view logic with
 * synthetic data; who may act is still decided by the database.
 */

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const DEL = 'b0000000-0000-4000-8000-000000000001';
const JDH = 'b0000000-0000-4000-8000-000000000002';

const ZERO: Record<UnresolvedCashKind, number> = {
  deposit_overdue: 0,
  verification_overdue: 0,
  reversed_undeposited: 0,
  reconciliation_missing: 0,
  reconciliation_awaiting_verification: 0,
  reconciliation_stale: 0,
};

function branch(id: string, name: string, extra: Partial<CashBranchView> = {}): CashBranchView {
  return {
    branchId: id,
    branchName: name,
    cashInHandPaise: '0',
    recordedUnverifiedCashPaise: '0',
    undepositedVerified: [],
    unresolved: [],
    unresolvedTotals: { ...ZERO },
    oldestUnresolvedDate: {},
    unresolvedTruncated: false,
    deposits: [],
    reconciliations: [],
    ...extra,
  };
}

const policy: FinancePolicyView = {
  versionNo: 1,
  effectiveAt: '2026-11-01T00:00:00Z',
  receiptMaxPaise: '10000000',
  cashPayerDayCapPaise: '4999900',
  cashTripCapPaise: '4999900',
  cashDepositDays: 1,
  reconciliationRequired: true,
  reason: 'Synthetic',
  createdByName: null,
  createdAt: '2026-11-01T00:00:00Z',
};

/** React's static markup splits adjacent text with empty comments. */
const clean = (html: string) => html.replaceAll('<!-- -->', '');

const stub: FinanceAction = async () => ({ status: 'idle' });
const actions = new Proxy({}, { get: () => stub }) as FinanceActions;

const viewer: AccountsSectionViewer = { canUseAccounts: true, canSeeAccountsDesk: true };

const quietHeadOffice = branch(DEL, 'Delhi');
const busyJodhpur = branch(JDH, 'Jodhpur', {
  undepositedVerified: [{ receiptId: 'r1', receiptNo: 'R-1', amountPaise: '150000', receivedOn: '2026-11-01', dealReference: 'SYN-1' }],
  unresolvedTotals: { ...ZERO, reconciliation_missing: 2 },
});

describe('Branch cash: which branch tab is shown', () => {
  it('a listed ?branch= wins', () => {
    expect(pickCashBranch([quietHeadOffice, busyJodhpur], DEL)?.branchId).toBe(DEL);
  });

  it('otherwise the first branch with work, then the first branch', () => {
    expect(pickCashBranch([quietHeadOffice, busyJodhpur], null)?.branchId).toBe(JDH);
    expect(pickCashBranch([quietHeadOffice, busyJodhpur], 'not-a-branch')?.branchId).toBe(JDH);
    expect(pickCashBranch([quietHeadOffice, branch(JDH, 'Jodhpur')], undefined)?.branchId).toBe(DEL);
    expect(pickCashBranch([], DEL)).toBeNull();
  });

  it('work includes a deposit or count waiting for verification, not only unresolved items', () => {
    expect(cashBranchHasWork(quietHeadOffice)).toBe(false);
    const recordedCount = branch(DEL, 'Delhi', {
      reconciliations: [
        {
          reconciliationId: 'c1',
          businessDate: '2026-11-01',
          countedPaise: '0',
          expectedPaise: '0',
          differencePaise: '0',
          unverifiedCashPaise: '0',
          note: null,
          status: 'recorded',
          stale: false,
          recordedByName: null,
          verifiedByName: null,
          actions: { verify: null },
        },
      ],
    });
    expect(cashBranchHasWork(recordedCount)).toBe(true);
  });

  it('tab addresses keep the company only when the page was opened for one', () => {
    expect(cashBranchHref(JDH, null)).toBe(`/app/accounts/cash?branch=${JDH}`);
    expect(cashBranchHref(JDH, ENTITY)).toBe(`/app/accounts/cash?entity=${ENTITY}&branch=${JDH}`);
  });
});

describe('Branch cash page', () => {
  const overview: CashOverview = { legalEntityId: ENTITY, policy, branches: [quietHeadOffice, busyJodhpur] };
  const html = (props: Partial<Parameters<typeof CashOverviewView>[0]> = {}) =>
    clean(renderToStaticMarkup(createElement(CashOverviewView, { overview, actions, viewer, ...props })));

  it('shows the section tabs, one tab per branch and only the chosen branch', () => {
    const out = html();
    expect(out).toContain('aria-label="Cash and bank sections"');
    expect(out).toContain('href="/app/accounts/destinations"');
    expect(out).toContain('aria-label="Branches"');
    const current = (out.match(/<a [^>]*>/g) ?? []).filter((a) => a.includes('aria-current="page"'));
    expect(current.some((a) => a.includes(`href="/app/accounts/cash?branch=${JDH}"`))).toBe(true);
    expect(current.some((a) => a.includes(`href="/app/accounts/cash?branch=${DEL}"`))).toBe(false);
    expect(out).toContain('<h2 id="cash-' + JDH);
    expect(out).not.toContain('<h2 id="cash-' + DEL);
  });

  it('"Record deposit" is at the top only while verified cash waits; "Record cash count" is always there', () => {
    const busy = html();
    expect(busy).toContain('Record deposit<span class="sr-only"> for Jodhpur</span>');
    expect(busy).toContain('Record cash count<span class="sr-only"> for Jodhpur</span>');
    const quiet = html({ branchId: DEL });
    expect(quiet).not.toContain('Record deposit<span');
    expect(quiet).toContain('Record cash count<span class="sr-only"> for Delhi</span>');
    expect(quiet).toContain('No verified cash is waiting to be deposited at Delhi.');
  });

  it('forms are not on the page until a button opens them', () => {
    const out = html();
    expect(out).not.toContain('Record a bank deposit for Jodhpur');
    expect(out).not.toContain('Record a daily cash count for Jodhpur');
  });

  it('one branch: no branch tabs; no viewer flags: no section tabs', () => {
    const out = clean(renderToStaticMarkup(createElement(CashOverviewView, { overview: { ...overview, branches: [busyJodhpur] }, actions })));
    expect(out).not.toContain('aria-label="Branches"');
    expect(out).not.toContain('aria-label="Cash and bank sections"');
  });
});

function version(n: number, extra: Partial<DestinationVersionView> = {}): DestinationVersionView {
  return {
    versionId: `v${n}`,
    versionNo: n,
    status: 'approved',
    predecessorVersionNo: null,
    holderName: 'Synthetic Holder',
    bankName: 'Synthetic Bank',
    accountMasked: 'XXXX6789',
    ifsc: 'SYNB0001234',
    payeeName: null,
    upiMasked: null,
    makerId: 'u1',
    makerName: 'Synthetic Maker',
    createdAt: '2026-11-01T00:00:00Z',
    decidedByName: null,
    decidedAt: null,
    decisionReason: null,
    ...extra,
  };
}

function account(extra: Partial<CompanyDestinationView> & Pick<CompanyDestinationView, 'versions'>): CompanyDestinationView {
  const versions = extra.versions;
  return {
    destinationId: 'd1',
    kind: 'bank',
    label: 'Synthetic account',
    rowVersion: 1,
    state: 'approved',
    createdByName: null,
    createdAt: '2026-11-01T00:00:00Z',
    retiredAt: null,
    retiredByName: null,
    retireReason: null,
    current: versions.find((v) => v.status === 'approved') ?? null,
    pending: versions.find((v) => v.status === 'submitted') ?? null,
    latestVersionNo: Math.max(...versions.map((v) => v.versionNo)),
    actions: { submit: null, decide: 'wrong_state', retire: null },
    ...extra,
  };
}

describe('Company accounts: next step per account', () => {
  it('an open version the viewer may decide jumps to the decision', () => {
    const d = account({ state: 'submitted', versions: [version(1, { status: 'submitted' })], actions: { submit: 'wrong_state', decide: null, retire: null } });
    expect(destinationNextStep(d)).toEqual({ kind: 'jump', label: 'Approve or return version 1', targetId: 'dest-next-d1' });
  });

  it('the maker of the open version is told another Accounts person decides', () => {
    const d = account({ state: 'submitted', versions: [version(1, { status: 'submitted' })], actions: { submit: 'wrong_state', decide: 'own_record', retire: null } });
    expect(destinationNextStep(d)).toEqual({ kind: 'text', text: 'You submitted this version. Another Accounts person must approve or return it.' });
  });

  it('a retired account with a late version can only be returned', () => {
    const d = account({
      state: 'retired',
      versions: [version(1), version(2, { status: 'submitted' })],
      actions: { submit: 'wrong_state', decide: null, retire: 'wrong_state' },
    });
    expect(destinationNextStep(d)).toMatchObject({ kind: 'jump', label: 'Return version 2' });
  });

  it('a returned account asks for a corrected version; an approved one has nothing to do', () => {
    const returned = account({ state: 'returned', versions: [version(1, { status: 'returned' })] });
    expect(destinationNextStep(returned)).toEqual({ kind: 'jump', label: 'Submit a corrected version', targetId: 'dest-change-d1' });
    expect(destinationNextStep(account({ versions: [version(1)] }))).toEqual({ kind: 'text', text: 'Nothing to do' });
    expect(destinationNextStep(account({ state: 'retired', versions: [version(1)], actions: { submit: 'wrong_state', decide: 'wrong_state', retire: 'wrong_state' } }))).toEqual({
      kind: 'text',
      text: 'Nothing to do',
    });
  });

  it('jump targets never reuse the decision forms’ "dest-decide-" ids', () => {
    expect(destinationTargetId({ destinationId: 'd1' }, 'heading')).toBe('dest-d1');
    expect(destinationTargetId({ destinationId: 'd1' }, 'decide')).toBe('dest-next-d1');
    expect(destinationTargetId({ destinationId: 'd1' }, 'submit')).toBe('dest-change-d1');
  });
});

describe('Company accounts page', () => {
  const page: CompanyDestinationsPage = {
    entityId: ENTITY,
    destinations: [account({ state: 'submitted', versions: [version(1, { status: 'submitted' })], actions: { submit: 'wrong_state', decide: null, retire: null } })],
  };

  it('table at the top, details below, add button in the header, add form not on the page', () => {
    const out = clean(renderToStaticMarkup(createElement(CompanyDestinationsView, { page, actions, viewer })));
    expect(out).toContain('aria-label="Cash and bank sections"');
    expect(out).toContain('aria-label="Company accounts summary"');
    expect(out).toContain('href="#dest-next-d1"');
    expect(out).toContain('id="dest-next-d1"');
    expect(out.indexOf('Company accounts summary')).toBeLessThan(out.indexOf('Account details'));
    expect(out).toContain('Add a company account</button>');
    expect(out).not.toContain('aria-label="Add a company account"');
    // Masked values only.
    expect(out).toContain('XXXX6789');
  });
});
