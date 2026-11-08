import type {
  DealVisaHistoryEventDTO,
  DealVisaNoticeDTO,
  DealVisaSummaryDTO,
  VisaApplicantDTO,
  VisaApplicationState as DtoApplicationState,
  VisaBookingChangeDTO,
  VisaCostKind as DtoCostKind,
  VisaDocumentDTO,
  VisaExpenseStatus as DtoExpenseStatus,
  VisaFeeDTO,
  VisaFileDTO,
  VisaHandoverMethod,
  VisaHomeCountsDTO,
  VisaKind as DtoKind,
  VisaNotReadyToken as DtoNotReadyToken,
  VisaPaidBy as DtoPaidBy,
  VisaPaymentMode as DtoPaymentMode,
  VisaQueueDTO,
  VisaQueueTaskDTO,
  VisaReturnedFeeDTO,
  VisaStepDTO,
  VisaTaskStatusDTO,
  VisaWorkspaceDTO,
} from '@/modules/visa/contracts';

/*
 * Visa and passport screens (Track D): the shapes the views render are the
 * server module's DTOs (src/modules/visa/dto.ts, Track B; frozen contract
 * section 9), named here once so every view imports from one place. No
 * selling price, customer money, customer receipt, contact detail or bank
 * value exists in these shapes; the passport object is the assignee's only.
 */

export type VisaQueueView = VisaQueueDTO;
export type VisaQueueTask = VisaQueueTaskDTO;
export type VisaTaskStatus = VisaTaskStatusDTO;
export type VisaOpenStep = NonNullable<VisaTaskStatusDTO['step']>;
export type VisaStep = VisaStepDTO;
export type VisaWorkspace = VisaWorkspaceDTO;
export type VisaApplicant = VisaApplicantDTO;
export type VisaDocument = VisaDocumentDTO;
export type VisaFee = VisaFeeDTO;
export type VisaTaskFile = VisaFileDTO;
export type VisaReturnedFee = VisaReturnedFeeDTO;
export type VisaBookingChange = VisaBookingChangeDTO;
export type VisaApplicationState = DtoApplicationState;
export type VisaKind = DtoKind;
export type VisaNotReadyToken = DtoNotReadyToken;
export type VisaPaidBy = DtoPaidBy;
export type VisaPaymentMode = DtoPaymentMode;
export type VisaCostKind = DtoCostKind;
export type VisaExpenseStatus = DtoExpenseStatus;
export type HandoverMethod = VisaHandoverMethod;
export type VisaPaxType = 'adult' | 'child' | 'infant';
export type VisaClosedReason = NonNullable<VisaApplicantDTO['closed']>['reason'];
export type DealVisaSummary = DealVisaSummaryDTO;
export type DealVisaNotice = DealVisaNoticeDTO;
export type DealVisaEvent = DealVisaHistoryEventDTO;
export type VisaHomeCounts = VisaHomeCountsDTO;
