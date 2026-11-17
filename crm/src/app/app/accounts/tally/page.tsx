import type { Metadata } from 'next';
import { recordsFilterToParams } from '@/modules/accounts-desk/filters';
import { loadDailyCheck, loadRecords, loadTallyExports } from '@/modules/accounts-desk/server/queries';
import { createTallyFileAction, previewTallyFileAction, stageTallyMatchAction } from '@/modules/accounts-desk/server/tally-file-actions';
import { createTallyExportAction, linkSupplierDocumentAction, matchTallyRecordAction, raiseTallyExceptionAction, reopenTallyRecordAction } from '@/modules/accounts-desk/server/actions';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { LoadMoreAction } from '@/views/accounts-desk/records-table';
import { TallyNoAccess, TallyPage } from '@/views/accounts-desk/tally';
import { TallyFileSections } from '@/views/tally-file/sections';
import type { TallyFileHeader } from '@/views/tally-file/types';
import type { RecordsFilter } from '@/views/accounts-desk/types';
import { loadLinkTargetsAction, loadMoreRecordsAction } from '../records/actions';

export const metadata: Metadata = { title: 'Tally' };

const act = (a: unknown) => a as DecisionAction;
const EXCEPTIONS: RecordsFilter = { tallyStatus: 'exception' };

/**
 * Accounts › Tally (contract 7.2, 11.3), Accounts only: export form, past
 * exports (re-download through the audited CSV route) and open exceptions.
 * Accounts phase 3 (contract 7.3, 7.4, screen 15.7): the Tally import file
 * (preview, make, XML files with their left-out lists) and the matching
 * upload of Tally's Day Book come first; CSV exports keep their own list.
 */
export default async function TallyRoute() {
  const staff = await requireStaff();
  const [exportsView, exceptions, daily] = await Promise.all([
    loadTallyExports(staff),
    loadRecords(staff, EXCEPTIONS, null, 100).catch(() => null),
    loadDailyCheck(staff).catch(() => null),
  ]);
  if (!exportsView) return <TallyNoAccess />;
  const enabled = exportsView.entities.filter((e) => e.exportEnabled);
  const branches = new Map<string, string>();
  for (const e of enabled) for (const b of e.branches) branches.set(b.branchId, b.name);
  // Phase 3: the XML file switch is per company; the file form offers the companies that have it on.
  const xmlEntities = exportsView.entities.filter((e) => e.xmlEnabled);
  const xmlBranches = new Map<string, string>();
  for (const e of xmlEntities) for (const b of e.branches) xmlBranches.set(b.branchId, b.name);
  const xmlFiles: TallyFileHeader[] = exportsView.items
    .filter((i) => i.format === 'xml')
    .map((i) => ({ exportId: i.exportId, exportNo: i.exportNo, format: 'xml', periodFrom: i.periodFrom, periodTo: i.periodTo, kinds: i.kinds, rowCount: i.rowCount, leftOutCount: i.leftOutCount ?? 0, includeReason: i.includeReason ?? null, companyName: i.companyName ?? null, createdAt: i.createdAt, createdByName: i.createdByName }));
  // The saved Tally company name: shown in the heading when every company offered has one name (else the preview names it).
  const companyNames = [...new Set(xmlEntities.map((e) => e.companyName ?? null))];
  const companyName = companyNames.length === 1 ? companyNames[0]! : null;
  const fileEntities = (xmlEntities.length ? xmlEntities : exportsView.entities).map((e) => ({ id: e.entityId, name: e.name }));
  return (
    <TallyPage
      fileSections={
        <TallyFileSections
          model={{ enabled: xmlEntities.length > 0, companyName, entities: fileEntities, branches: [...xmlBranches].map(([id, name]) => ({ id, name })), files: xmlFiles }}
          actions={{ preview: act(previewTallyFileAction), create: act(createTallyFileAction), stageMatch: act(stageTallyMatchAction) }}
        />
      }
      view={{
        exportEnabled: enabled.length > 0,
        entities: enabled.map((e) => ({ id: e.entityId, name: e.name })),
        branches: [...branches].map(([id, name]) => ({ id, name })),
        exports: exportsView.items.filter((i) => i.format !== 'xml'),
        exceptions: exceptions && exceptions.ok && exceptions.data ? exceptions.data.items : [],
        exceptionsNextAfter: exceptions && exceptions.ok && exceptions.data?.hasMore ? exceptions.data.nextAfter : null,
        daily,
      }}
      exportAction={act(createTallyExportAction)}
      rowActions={{ match: act(matchTallyRecordAction), exception: act(raiseTallyExceptionAction), reopen: act(reopenTallyRecordAction), linkTask: act(linkSupplierDocumentAction) }}
      loadLinkTargets={loadLinkTargetsAction}
      loadMoreExceptions={loadMoreRecordsAction.bind(null, recordsFilterToParams(EXCEPTIONS).toString()) as LoadMoreAction}
    />
  );
}
