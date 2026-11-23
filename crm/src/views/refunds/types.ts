/*
 * The refund screens type against track C's DTOs (`@/modules/refunds/contracts`,
 * contract 7.1, 7.2, 7.5 R-C1..R-C3) one to one. Type-only re-exports: no
 * zod reaches a client bundle (CSP blocks eval).
 */
export type {
  DealRefundsView,
  Paise,
  PayeeKind,
  PayoutMode,
  RefundKind,
  RefundListFilter,
  RefundListPage,
  RefundListRow,
  RefundOutcome,
  RefundRequestCan,
  RefundRequestView,
  RefundStatus,
  RefundViewer,
  SupplierRefundDueRow,
  SupplierRefundMode,
  SupplierRefundReceiptView,
  SupplierRefundSource,
  SupplierRefundSourceView,
  SupplierRefundsDueFilter,
  SupplierRefundsDuePage,
} from '@/modules/refunds/contracts';

/** Who reads Accounts › Refunds. */
export type RefundsDeskViewer = { kind: 'accounts'; entityName: string };
