/*
 * The Accounts desk screens type against track B's DTOs
 * (`@/modules/accounts-desk/contracts`, contract sections 7–8) one to one;
 * this file only adds the few view-side shapes the screens need (who is
 * reading, the Tally page model).
 */
import type { DailyCheck, RecordRow, RecordsPage, TallyExportHeader } from '@/modules/accounts-desk/contracts';

export {
  DUES_STATUSES,
  RECORD_KINDS,
  TALLY_RECORD_KINDS,
  TALLY_STATUSES,
  type DailyCheck,
  type DealDues,
  type DealTallyInvoiceView,
  type Direction,
  type DuesBasis,
  type DuesFilter,
  type DuesInstalment as Instalment,
  type DuesPage,
  type DuesRow,
  type DuesStatus,
  type InstalmentStatus,
  type OriginalWhat,
  type Paise,
  type RecordDepartment as Department,
  type RecordKind,
  type RecordLinkKind as LinkKind,
  type RecordRow,
  type RecordsFilter,
  type RecordsPage,
  type RecordsTotals,
  type RecordStage,
  type ReviewStatus as ReviewState,
  type SupplierPayableRow as SupplierPayable,
  type TallyExportCreated as TallyExportResult,
  type TallyExportHeader,
  type TallyRecordKind,
  type TallyAnyRecordKind,
  type TallyStatus,
} from '@/modules/accounts-desk/contracts';

/** Who is reading the workspace: Accounts of the entity (actions) or a branch Manager (view only). */
export type DeskViewer = { kind: 'accounts'; entityName: string } | { kind: 'manager'; branchNames: string[] };

/** Who reads the Deal's dues card. */
export type DuesViewer = 'accounts' | 'manager' | 'sales';

/** Accounts › Tally page model (built by the route from loadTallyExports, loadRecords and loadDailyCheck). */
export interface TallyPageView {
  /** accounts_settings.tally_export_enabled for at least one company the viewer exports for. */
  exportEnabled: boolean;
  entities: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  exports: TallyExportHeader[];
  /** Open exceptions (records with Tally status exception): the first keyset page. */
  exceptions: RecordRow[];
  /** Keyset cursor of the exceptions list ("Show more"); null = that is all. */
  exceptionsNextAfter?: RecordsPage['nextAfter'];
  daily: DailyCheck | null;
}
