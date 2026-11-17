import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { TallyMethod } from '@/views/accounts-desk/r4-address';
import { TallyPage, type TallyCsvView } from '@/views/accounts-desk/tally';
import { TallyFileLoading, TallyFilesList, TallyLeftOutView } from '@/views/tally-file/files';
import { TALLY_FILE_REFUSAL } from '@/views/tally-file/labels';
import { TallyMatchBatchView } from '@/views/tally-file/match-batch';
import { TallyPartyNameField } from '@/views/tally-file/party-name';
import { TallyFileNoAccess, TallyFileSections, type TallyFileActions, type TallyFileModel } from '@/views/tally-file/sections';
import { INBOX, INBOX_ACCOUNTS, TALLY_VIEW } from './acc-fixtures';
import { accExportOk, accNoticeNoop } from './acc-preview-actions';
import { BRANCHES, ENTITIES, FILES, LEFT_OUT_PAGE, MATCH_BATCH, MATCH_PAGE, TALLY_PREVIEW, TALLY_PREVIEW_EMPTY } from './acc3-tally-fixtures';
import * as A from './acc3-tally-preview-actions';

/*
 * Accounts phase 3 preview states (acc3-tally-*), track U: Accounts › Tally
 * "Make Tally file" with its preview, the files list, the left-out list,
 * "Upload Tally vouchers" and one staged match, and the Tally party name on
 * the customer page. Synthetic props only; rendered by the design-review
 * gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts 1',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canSeeAccountsDesk: true,
};
const managerViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canUseAccounts: false, canSeeAccountsDesk: false, canSeeBranchMoney: true, canSeeApprovals: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX } }}>
      {body}
    </StaffShell>
  );
}

const MODEL: TallyFileModel = { enabled: true, companyName: 'Holiday Chacha Pvt Ltd (Copy)', entities: ENTITIES, branches: BRANCHES, files: FILES };
const ACTIONS: TallyFileActions = { preview: act(A.tfPreviewOk), create: act(A.tfCreateOk), stageMatch: act(A.tfStageOk) };
const ok = (data: unknown) => ({ ok: true as const, message: 'Checked.', data });
const refused = (code: keyof typeof TALLY_FILE_REFUSAL) => ({ ok: false as const, code, message: TALLY_FILE_REFUSAL[code] });

function tally(over: { model?: Partial<TallyFileModel>; actions?: Partial<TallyFileActions>; initial?: Parameters<typeof TallyFileSections>[0]['initial'] } = {}) {
  return shell(
    accountsViewer,
    '/app/accounts/tally',
    <div className="font-sans text-base text-copy">
      <PageHeader title="Tally" description="Make the Tally file, match Tally's voucher numbers and keep track of exceptions. Tally stays the official accounts; the CRM never connects to it." />
      <TallyFileSections model={{ ...MODEL, ...over.model }} actions={{ ...ACTIONS, ...over.actions }} initial={over.initial} />
    </div>,
  );
}
const match = (page: Parameters<typeof TallyMatchBatchView>[0]['page'], over: Partial<Parameters<typeof TallyMatchBatchView>[0]> = {}) =>
  shell(accountsViewer, '/app/accounts/tally', <TallyMatchBatchView page={page} actions={{ apply: act(A.tfApplyOk), cancel: act(A.tfCancelOk) }} {...over} />);

function customer(body: ReactNode) {
  return shell(
    accountsViewer,
    '/app/customers',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Customer" title="Synthetic Traveller Co" />
      <Card>
        <CardHeader>
          <CardTitle>Tally</CardTitle>
        </CardHeader>
        <CardBody>{body}</CardBody>
      </Card>
    </div>,
  );
}

/*
 * UX redesign R4 (owner answer D11): the whole Tally page with only the
 * switched-on method; two pill tabs when both are on; files of a switched-off
 * method in a closed fold; open exceptions as a count with a link to
 * Documents and money.
 */
const CSV_VIEW: TallyCsvView = { exportEnabled: true, entities: TALLY_VIEW.entities, branches: TALLY_VIEW.branches, exports: TALLY_VIEW.exports, daily: TALLY_VIEW.daily };
function tallyPage(on: { file: boolean; csv: boolean }, method: TallyMethod | null) {
  return shell(
    accountsViewer,
    '/app/accounts/tally',
    <TallyPage
      view={{ ...CSV_VIEW, exportEnabled: on.csv }}
      method={method}
      fileOn={on.file}
      fileSections={method === 'file' ? <TallyFileSections model={MODEL} actions={ACTIONS} /> : undefined}
      earlierFiles={on.file ? undefined : <TallyFilesList files={FILES} />}
      exportAction={act(accExportOk)}
    />,
  );
}

const PARTY = { partyId: 'a0003701-0000-4000-8000-000000003701', name: null, rowVersion: 3 };

const states: Record<string, () => ReactNode> = {
  /* Accounts › Tally */
  'acc3-tally-page': () => tally(),
  'acc3-tally-preview': () => tally({ initial: { preview: ok(TALLY_PREVIEW) } }),
  'acc3-tally-preview-nothing': () => tally({ actions: { preview: act(A.tfPreviewNothing), create: act(A.tfCreateNothing) }, initial: { preview: ok(TALLY_PREVIEW_EMPTY) } }),
  'acc3-tally-created': () => tally({ initial: { create: ok({ exportId: FILES[0]!.exportId, exportNo: FILES[0]!.exportNo, lines: 3, leftOut: 3 }) } }),
  'acc3-tally-refused-nothing': () => tally({ actions: { create: act(A.tfCreateNothing) }, initial: { create: refused('nothing_to_export') } }),
  'acc3-tally-refused-off': () => tally({ actions: { create: act(A.tfCreateOff) }, initial: { create: refused('tally_xml_off') } }),
  'acc3-tally-include-again': () =>
    tally({ actions: { create: act(A.tfCreateReason) }, initial: { includeAgain: true, create: { ok: false, code: 'invalid_input', message: 'Say why the entries go in again (10 to 500 characters).', field: 'includeReason' } as never } }),
  'acc3-tally-off': () => tally({ model: { enabled: false } }),
  'acc3-tally-no-files': () => tally({ model: { files: [] } }),
  'acc3-tally-files-error': () => tally({ model: { files: 'error' } }),
  'acc3-tally-loading': () => shell(accountsViewer, '/app/accounts/tally', <TallyFileLoading />),
  'acc3-tally-no-access': () => shell(managerViewer, '/app/accounts/tally', <TallyFileNoAccess />),

  /* Whole page by switched-on method (R4, D11) */
  'acc3-tally-method-both': () => tallyPage({ file: true, csv: true }, 'file'),
  'acc3-tally-method-both-csv': () => tallyPage({ file: true, csv: true }, 'csv'),
  'acc3-tally-method-file-only': () => tallyPage({ file: true, csv: false }, 'file'),
  'acc3-tally-method-csv-only': () => tallyPage({ file: false, csv: true }, 'csv'),
  'acc3-tally-method-none': () => tallyPage({ file: false, csv: false }, null),

  /* Left-out list */
  'acc3-tally-left-out': () => shell(accountsViewer, '/app/accounts/tally', <TallyLeftOutView page={LEFT_OUT_PAGE} />),
  'acc3-tally-left-out-empty': () => shell(accountsViewer, '/app/accounts/tally', <TallyLeftOutView page={{ ...LEFT_OUT_PAGE, items: [], hasMore: false, nextAfter: null }} />),
  'acc3-tally-left-out-error': () => shell(accountsViewer, '/app/accounts/tally', <TallyLeftOutView page="error" />),

  /* Upload Tally vouchers */
  'acc3-tally-upload-checked': () => tally({ initial: { match: ok(MATCH_BATCH) } }),
  'acc3-tally-upload-refused': () => tally({ actions: { stageMatch: act(A.tfStageDuplicate) }, initial: { match: { ok: false, code: 'already_recorded', message: 'This file was already uploaded. Open the earlier upload from the Tally page.' } } }),
  'acc3-tally-match': () => match(MATCH_PAGE),
  'acc3-tally-match-differs': () => match({ ...MATCH_PAGE, outcome: 'amount_differs', rows: MATCH_PAGE.rows.filter((r) => r.outcome === 'amount_differs') }),
  'acc3-tally-match-apply-open': () => match(MATCH_PAGE, { preview: { dialog: 'apply' } }),
  'acc3-tally-match-apply-changed': () => match(MATCH_PAGE, { actions: { apply: act(A.tfApplyChanged), cancel: act(A.tfCancelOk) }, preview: { dialog: 'apply', state: refused('version_changed') } }),
  'acc3-tally-match-cancel-open': () => match(MATCH_PAGE, { preview: { dialog: 'cancel' } }),
  'acc3-tally-match-applied': () => match({ ...MATCH_PAGE, batch: { ...MATCH_BATCH, status: 'applied', appliedAt: '2026-11-13T05:45:00Z' } }),
  'acc3-tally-match-nothing': () =>
    match({ ...MATCH_PAGE, batch: { ...MATCH_BATCH, summary: { matched: 0, amount_differs: 0, not_found: 2, already_matched: 0, duplicate_in_file: 0, no_tag: 1 } }, rows: MATCH_PAGE.rows.filter((r) => r.outcome === 'not_found' || r.outcome === 'no_tag') }),
  'acc3-tally-match-error': () => match('error'),

  /* Customer page › Tally party name */
  'acc3-tally-party-name': () => customer(<TallyPartyNameField party={PARTY} action={act(A.tfPartyNameOk)} />),
  'acc3-tally-party-name-set': () => customer(<TallyPartyNameField party={{ ...PARTY, name: 'Synthetic Traveller Co (Jodhpur)' }} action={act(A.tfPartyNameOk)} />),
  'acc3-tally-party-name-readonly': () => customer(<TallyPartyNameField party={PARTY} action={null} />),
};

export const ACC3_TALLY_STATES = Object.keys(states);

export function renderAcc3TallyState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
