import type { z } from 'zod';
import type {
  AdminAccountsSettingsSchema,
  TallyMappingHistorySchema,
  TallyMappingSchema,
  DailyCheckSchema,
  DealDuesSchema,
  DuesPageSchema,
  RecordsPageSchema,
  RecordsTotalsSchema,
  SupplierPayablesSchema,
  TallyExportHeaderSchema,
  TallyExportsSchema,
} from './commands';
import type {
  AdminAccountsSettingsView,
  DailyCheck,
  DealDues,
  DuesPage,
  RecordRow,
  RecordsPage,
  RecordsTotals,
  SupplierPayablesView,
  TallyExportHeader,
  TallyExportsView,
  TallyMappingHistoryView,
  TallyMappingView,
} from './contracts';

/**
 * Validated records -> page DTOs. The database already shapes and fences the
 * values (Manager rows carry no voucher references, exception reasons or file
 * links; Sales dues carry no supplier payables); these functions copy only
 * the listed keys so a page never receives an unlisted field.
 */

type Out<T extends z.ZodType> = z.output<T>;

function toRow(r: Out<typeof RecordsPageSchema>['items'][number]): RecordRow {
  return {
    rowId: r.rowId,
    kind: r.kind,
    recordId: r.recordId,
    recordDate: r.recordDate,
    createdAt: r.createdAt,
    reference: r.reference,
    otherReferences: [...r.otherReferences],
    dealId: r.dealId,
    dealReference: r.dealReference,
    bitrixDealId: r.bitrixDealId,
    branchName: r.branchName,
    collectingBranchName: r.collectingBranchName,
    department: r.department,
    taskId: r.taskId,
    serviceLabel: r.serviceLabel,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    amountPaise: r.amountPaise,
    direction: r.direction,
    statusCode: r.statusCode,
    stage: r.stage,
    reviewStatus: r.reviewStatus,
    tally: { ...r.tally },
    files: { count: r.files.count, links: r.files.links.map((l) => ({ ...l })) },
    original: r.original ? { ...r.original } : null,
    link: { ...r.link },
    can: { ...r.can },
  };
}

export function toRecordsPage(r: Out<typeof RecordsPageSchema>): RecordsPage {
  return { scope: { ...r.scope }, items: r.items.map(toRow), hasMore: r.hasMore, nextAfter: r.nextAfter };
}

export function toRecordsTotals(r: Out<typeof RecordsTotalsSchema>): RecordsTotals {
  return { count: r.count, byKind: r.byKind.map((k) => ({ ...k })) };
}

export function toDailyCheck(r: Out<typeof DailyCheckSchema>): DailyCheck {
  return {
    exceptionOwner: { ...r.exceptionOwner },
    exceptionsOpen: { ...r.exceptionsOpen },
    changedAfterExport: r.changedAfterExport,
    originalsMissing: r.originalsMissing,
    receiptsAwaitingVerificationOverOneWorkingDay: r.receiptsAwaitingVerificationOverOneWorkingDay,
    paymentsApprovedNotRecordedOverOneWorkingDay: r.paymentsApprovedNotRecordedOverOneWorkingDay,
    urgentNoticesUnopenedOverOneWorkingDay: r.urgentNoticesUnopenedOverOneWorkingDay.map((u) => ({ ...u })),
    documentsToRelease: r.documentsToRelease,
    pdfFailed: r.pdfFailed,
    refundPayoutsDueOverOneWorkingDay: r.refundPayoutsDueOverOneWorkingDay,
    supplierRefundsToVerify: r.supplierRefundsToVerify,
    supplierRefundsDue: r.supplierRefundsDue,
    billsHeldOverOneWorkingDay: r.billsHeldOverOneWorkingDay,
    customerMessagesFailedOverOneWorkingDay: r.customerMessagesFailedOverOneWorkingDay,
    tallyFileUnmatchedOverOneWorkingDay: r.tallyFileUnmatchedOverOneWorkingDay,
    messageQueueOldestMinutes: r.messageQueueOldestMinutes,
    writeOffsToReview: r.writeOffsToReview,
    filters: {
      exceptionsOpen: { ...r.filters.exceptionsOpen },
      changedAfterExport: { ...r.filters.changedAfterExport },
      originalsMissing: { ...r.filters.originalsMissing },
      receiptsAwaitingVerificationOverOneWorkingDay: { ...r.filters.receiptsAwaitingVerificationOverOneWorkingDay },
      paymentsApprovedNotRecordedOverOneWorkingDay: { ...r.filters.paymentsApprovedNotRecordedOverOneWorkingDay },
    },
  };
}

export function toDuesPage(r: Out<typeof DuesPageSchema>): DuesPage {
  return {
    scope: { ...r.scope },
    items: r.items.map((i) => ({ ...i, basis: { ...i.basis }, nextDue: i.nextDue ? { ...i.nextDue } : null })),
    hasMore: r.hasMore,
    nextAfter: r.nextAfter,
  };
}

export function toDealDues(r: Out<typeof DealDuesSchema>): DealDues {
  return {
    ...r,
    basis: { ...r.basis },
    nextDue: r.nextDue ? { ...r.nextDue } : null,
    instalments: r.instalments.map((i) => ({ ...i })),
    tallyInvoices: r.tallyInvoices.map((t) => ({ ...t })),
    supplierPayables: r.supplierPayables ? r.supplierPayables.map((s) => ({ ...s })) : null,
    writeOff: r.writeOff ? { ...r.writeOff } : null,
    writeOffNeedsReview: r.writeOffNeedsReview,
  };
}

export function toSupplierPayables(r: Out<typeof SupplierPayablesSchema>): SupplierPayablesView {
  return { dealId: r.dealId, dealReference: r.dealReference, suppliers: r.suppliers.map((s) => ({ ...s })) };
}

export function toTallyExportHeader(r: Out<typeof TallyExportHeaderSchema>): TallyExportHeader {
  return { ...r, kinds: [...r.kinds], branchNames: r.branchNames ? [...r.branchNames] : null };
}

export function toTallyExports(r: Out<typeof TallyExportsSchema>): TallyExportsView {
  return {
    entities: r.entities.map((e) => ({ ...e, branches: e.branches.map((b) => ({ ...b })) })),
    items: r.items.map(toTallyExportHeader),
  };
}

export function toAdminAccountsSettings(r: Out<typeof AdminAccountsSettingsSchema>): AdminAccountsSettingsView {
  return { ...r, candidates: r.candidates.map((c) => ({ ...c })) };
}

export function toTallyMapping(r: Out<typeof TallyMappingSchema>): TallyMappingView {
  return { entityId: r.entityId, rows: r.rows.map((row) => ({ ...row })), missingCount: r.missingCount };
}

export function toTallyMappingHistory(r: Out<typeof TallyMappingHistorySchema>): TallyMappingHistoryView {
  return { mappingId: r.mappingId, items: r.items.map((i) => ({ ...i })) };
}
