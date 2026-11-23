import type { Metadata } from 'next';
import { SectionTabs } from '@/components/ui/section-tabs';
import { loadDailyCheck, loadTallyExports } from '@/modules/accounts-desk/server/queries';
import { createTallyFileAction, previewTallyFileAction, stageTallyMatchAction } from '@/modules/accounts-desk/server/tally-file-actions';
import { createTallyExportAction } from '@/modules/accounts-desk/server/actions';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TALLY_PATH } from '@/views/accounts-desk/address';
import { tallyMethodFrom } from '@/views/accounts-desk/r4-address';
import { TallyNoAccess, TallyPage } from '@/views/accounts-desk/tally';
import { TallyEarlierFiles, TallyFileSections } from '@/views/tally-file/sections';
import type { TallyFileHeader } from '@/views/tally-file/types';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Tally' };

const act = (a: unknown) => a as DecisionAction;

/**
 * Accounts › Tally (contract 7.2, 11.3), Accounts only. Accounts phase 3
 * (contract 7.3, 7.4, screen 15.7): the Tally import file (preview, make,
 * XML files with their left-out lists) and the matching upload of Tally's
 * Day Book. UX redesign R4 (owner answer D11): only the switched-on method
 * shows (?method=file or ?method=csv when both are on; the old address opens
 * the first one on); files of a switched-off method stay in a fold. Open
 * exceptions are worked in Documents and money: the page shows the daily
 * check's count and links there.
 */
export default async function TallyRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const [exportsView, daily, sectionViewer, sp] = await Promise.all([loadTallyExports(staff), loadDailyCheck(staff).catch(() => null), accountsSectionViewer(staff), searchParams]);
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
  const fileOn = xmlEntities.length > 0;
  const method = tallyMethodFrom(sp.method, { file: fileOn, csv: enabled.length > 0 });
  return (
    <TallyPage
      method={method}
      fileOn={fileOn}
      fileSections={
        method === 'file' ? (
          <TallyFileSections
            model={{ enabled: fileOn, companyName, entities: fileEntities, branches: [...xmlBranches].map(([id, name]) => ({ id, name })), files: xmlFiles }}
            actions={{ preview: act(previewTallyFileAction), create: act(createTallyFileAction), stageMatch: act(stageTallyMatchAction) }}
          />
        ) : undefined
      }
      earlierFiles={!fileOn ? <TallyEarlierFiles files={xmlFiles} entityId={fileEntities[0]?.id ?? ''} stageMatch={act(stageTallyMatchAction)} /> : undefined}
      view={{
        exportEnabled: enabled.length > 0,
        entities: enabled.map((e) => ({ id: e.entityId, name: e.name })),
        branches: [...branches].map(([id, name]) => ({ id, name })),
        exports: exportsView.items.filter((i) => i.format !== 'xml'),
        daily,
      }}
      exportAction={act(createTallyExportAction)}
      sectionTabs={<SectionTabs section="tally" currentHref={TALLY_PATH} viewer={sectionViewer} />}
    />
  );
}
