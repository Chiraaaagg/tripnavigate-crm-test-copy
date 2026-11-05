/*
 * Flight screens (Track C): the shapes the views render, mirroring the frozen
 * DTOs of the Flight build contract (section 9: flight_queue, flight_workspace,
 * flight_money, flight_payment_context, deal_flight_summary,
 * deal_flight_history, flight_home_counts, manager_approvals().flightFares).
 * The server modules (src/modules/flight/**) own the real zod schemas; these
 * view types are structural copies so the screens and the preview gallery can
 * render before and after the server side lands. Paise stay decimal strings.
 * No booking selling price, receipt, funding or bank value appears here.
 */

export type FlightStatusCode = 'waiting' | 'in_progress' | 'all_confirmed' | 'done';

export interface FlightStatus {
  code: FlightStatusCode;
  text: string;
  confirmed: number;
  required: number;
}

export type FlightEntryMode = 'typed' | 'screenshot';
export type DealKind = 'package' | 'flight_only';
export type PaxType = 'adult' | 'child' | 'infant';
export type CrsType = 'amadeus' | 'galileo' | 'sabre' | 'airline_direct' | 'other';

/* ---------- 9.1 flight_queue ---------- */

export interface FlightQueueFlight {
  taskId: string;
  itemNo: number;
  title: string;
  route: string;
  firstDate: string | null;
  status: FlightStatus;
  entryMode: FlightEntryMode;
}

export interface FlightQueueChips {
  bookingChanged: boolean;
  unnamed: number;
  changesWaiting: number;
  faresWaiting: boolean;
  paymentNeeded: boolean;
}

export interface FlightQueueGroup {
  dealId: string;
  dealReference: string;
  branchName: string;
  status: FlightStatus;
  assigneeName: string | null;
  assignedToYou: boolean;
  canTake: boolean;
  firstDate: string | null;
  chips: FlightQueueChips;
  budgetPaise: string | null;
  flights: FlightQueueFlight[];
  /** Travellers on the Deal's flights (named + not named). Optional: older reads omit it. */
  travellerCount?: number | null;
  /** A decided change the Flight colleague has not marked as seen. */
  hasChangeDecision?: boolean;
  /** Nothing left on the done checklist. */
  readyToFinish?: boolean;
}

export interface FlightQueueView {
  groups: FlightQueueGroup[];
}

/* ---------- 9.2 flight_workspace ---------- */

export type ProgressKey = 'take' | 'approvals' | 'tickets' | 'payment' | 'etickets' | 'done';
export interface ProgressStep {
  key: ProgressKey;
  state: 'done' | 'current' | 'todo';
  sub: string | null;
}

export interface BookedLeg {
  legNo: number;
  from: string;
  to: string;
  date: string | null;
  arrivalDate: string | null;
  airline: string | null;
  flightNo: string | null;
  departTime: string | null;
  arriveTime: string | null;
}

export interface FlightTraveller {
  seq: number;
  fullName: string;
  type: PaxType;
  ageYears: number | null;
  specialNeeds: string | null;
  identity?: { dateOfBirth: string | null; nationality: string | null; passportNumber: string | null; passportExpiry: string | null } | null;
}

export interface TicketRevision {
  revisionNo: number;
  crsType: CrsType;
  crsPnr: string | null;
  airlinePnr: string;
  ticketNumber: string;
  reason: string | null;
  at: string;
  byName: string | null;
}

export interface SectorTicket {
  revisionNo: number;
  crsType: CrsType;
  crsPnr: string | null;
  airlinePnr: string;
  ticketNumber: string;
  batchNo: number | null;
  confirmedAt: string;
  confirmedByName: string | null;
  travellerChanged: boolean;
  canCorrect: boolean;
  history: TicketRevision[];
}

export interface SectorTraveller {
  seq: number;
  held: boolean;
  heldByChangeNo: number | null;
  ticket: SectorTicket | null;
}

export type SectorDisplayState = 'active' | 'pending' | 'replaced' | 'rejected' | 'withdrawn' | 'superseded' | 'booking_removed';

export interface FlightSector {
  sectorId: string;
  origin: 'booking' | 'screenshot' | 'change';
  status: 'active' | 'pending' | 'rejected' | 'withdrawn' | 'superseded' | 'booking_removed';
  displayState: SectorDisplayState;
  changeId: string | null;
  changeNo: number | null;
  from: string;
  to: string;
  departDate: string;
  departTime: string | null;
  arriveDate: string | null;
  arriveTime: string | null;
  airline: string | null;
  flightNo: string | null;
  cabin: string | null;
  rowVersion: number;
  canFillBlanks: boolean;
  canAlternate: boolean;
  canEditScreenshot: boolean;
  travellers: SectorTraveller[];
  endedTravellers: Array<{ seq: number; reason: string; at: string }>;
}

export type ChangeKind = 'alternative' | 'added_instead' | 'added_extra' | 'passenger_itinerary';
export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
export type DeciderKind = 'sales_owner' | 'branch_manager' | 'flight_owner';

export interface FlightChange {
  changeId: string;
  changeNo: number;
  kind: ChangeKind;
  status: ChangeStatus;
  deciderKind: DeciderKind;
  deciderName: string | null;
  remark: string;
  travellers: Array<{ seq: number; name: string | null }>;
  fromSectorIds: string[];
  newSectorIds: string[];
  basisVersionNo: number | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectReason: string | null;
  rowVersion: number;
  canWithdraw: boolean;
  needsAck: boolean;
}

export interface DiffLeg {
  from: string;
  to: string;
  date: string | null;
  arrivalDate?: string | null;
  airline: string | null;
  flightNo: string | null;
  departTime: string | null;
  arriveTime: string | null;
}

export interface BookingDiff {
  fromVersionId: string;
  toVersionId: string;
  fromVersionNo?: number | null;
  toVersionNo?: number | null;
  legs: {
    unchanged: Array<{ oldLegNo: number; newLegNo: number; leg?: DiffLeg }>;
    changed: Array<{ old: DiffLeg; new: DiffLeg }>;
    removed: Array<{ old: DiffLeg }>;
    added: Array<{ new: DiffLeg }>;
  };
  passengers: {
    added: Array<{ seq: number; name: string; type: PaxType }>;
    removed: Array<{ seq: number; name: string; type: PaxType }>;
    renamed: Array<{ seq: number; oldName: string; newName: string; oldType: PaxType; newType: PaxType }>;
  };
  otherFields: string[];
  impact: {
    ticketsOnRemoved: number;
    ticketsOfRemovedTravellers: number;
    ticketsRenamed: number;
    pendingChangesSuperseded: number;
    approvedChangesOnChangedLegs: Array<{ changeNo: number }>;
  };
}

export interface WorkspaceFlight {
  taskId: string;
  itemNo: number;
  title: string;
  status: FlightStatus;
  entryMode: FlightEntryMode;
  screenshotNote: string | null;
  screenshots: Array<{ fileId: string; fileName: string; mime: string; sizeBytes: number; href?: string }>;
  basisVersionNo: number | null;
  currentVersionNo: number;
  stateRowVersion: number | null;
  bookingChanged: BookingDiff | null;
  booked: {
    legs: BookedLeg[];
    cabin: string | null;
    preferredTime: string | null;
    notes: string | null;
    preferences: string | null;
    assistance: string | null;
    tripType: string | null;
    isReturn: boolean | null;
  };
  travellers: FlightTraveller[];
  unnamedCount: number;
  /** Sales' cost estimate per person for this flight's travellers (never a selling price). */
  salesFare?: {
    source: 'item' | 'all_flights';
    adultPaise: string | null;
    childPaise: string | null;
    infantPaise: string | null;
    adults: number;
    children: number;
    infants: number;
  } | null;
  sectors: FlightSector[];
  changes: FlightChange[];
}

export interface PnrGroup {
  airlinePnr: string;
  crsType: CrsType;
  crsPnr: string | null;
  active: boolean;
  sectors: Array<{ sectorId: string; departDate: string; departTime: string | null; flightNo: string | null; from: string; to: string; airline?: string | null }>;
  confirmedAt: string;
  travellers: Array<{ seq: number; name: string; type: PaxType; ticketNumbers: string[] }>;
}

export interface ETicketFile {
  evidenceId: string;
  taskId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storedAt: string;
  uploadedByName: string | null;
}

export interface FlightWorkspace {
  dealId: string;
  dealReference: string;
  branchName: string;
  dealKind: DealKind;
  tripScope: 'domestic' | 'international' | string | null;
  assignee: { name: string | null; isYou: boolean };
  canWork: boolean;
  canTake: boolean;
  canReassign: boolean;
  reassignCandidates: Array<{ userId: string; name: string }>;
  status: FlightStatus;
  progress: ProgressStep[];
  doneIssues: string[];
  canComplete: boolean;
  flights: WorkspaceFlight[];
  ticketsByPnr: PnrGroup[];
  eTickets: ETicketFile[];
  canUploadETicket: boolean;
  /** Assignee user id, needed by the Manager's reassign form (`p_expected_assignee`). */
  assigneeUserId?: string | null;
  /** Completed state facts for the "Done" line (optional in the read). */
  completedAt?: string | null;
  completedByName?: string | null;
}

/* ---------- 9.3 flight_money ---------- */

export type PaymentState =
  | 'unpaid'
  | 'direct_submitted'
  | 'direct_accepted'
  | 'direct_returned'
  | 'request_pending'
  | 'request_approved'
  | 'request_paid'
  | 'request_verified'
  | 'request_returned'
  | 'request_cancelled';

export type PaymentRoute = 'direct' | 'accounts' | 'manager';

export interface BatchFare {
  paxType: PaxType;
  basicPaise: string;
  kPaise: string;
  yqPaise: string;
  yrPaise: string;
  otherPaise: string;
  supplierPerPersonPaise: string;
  markupPaise?: string | null;
  discountPaise?: string | null;
  totalPerPersonPaise?: string | null;
  paxCount: number;
  supplierAmountPaise: string;
  customerAmountPaise?: string | null;
}

export interface MoneyBatch {
  batchId: string;
  batchNo: number;
  costTaskId: string;
  supplierId: string;
  supplierName: string;
  sectorIds: string[];
  confirmedAt: string;
  confirmedByName: string | null;
  fares?: BatchFare[];
  supplierCostPaise?: string | null;
  /** Paid earlier through an old manual flight cost record (null when not shown). */
  legacyPaidPaise?: string | null;
  /** Still to pay: supplier cost less legacyPaidPaise (null when not shown). */
  duePaise?: string | null;
  customerTotalPaise?: string | null;
  payment: {
    state: PaymentState;
    route?: PaymentRoute | null;
    refNo?: string | null;
    returnReason?: string | null;
    entryId?: string | null;
    entryRowVersion?: number | null;
    paymentId?: string | null;
    paymentRowVersion?: number | null;
    onHold?: boolean | null;
    holdReason?: string | null;
  };
  canPayDirect?: boolean;
  canRequest?: boolean;
  routePreview?: PaymentRoute | null;
}

export interface FareApproval {
  approvalId: string;
  approvalNo: number;
  status: 'pending' | 'approved' | 'returned' | 'withdrawn' | 'used';
  batchSupplierCostPaise: string;
  projectedSupplierCostPaise: string;
  budgetPaise: string | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  returnReason: string | null;
  rowVersion: number;
  canDecide: boolean;
  canWithdraw: boolean;
}

export interface FlightMoney {
  dealKind: DealKind;
  /** True only on a flight-only Deal for a caller without Purchase: may enter and see markup/discount (lead decision 5 Nov). */
  marginsAllowed?: boolean;
  budget: { dealPaise: string | null; tasks: Array<{ taskId: string; budgetPaise: string | null; source: 'typed' | 'estimate' | 'none' }> };
  supplierCostPaise: string;
  overBudget: boolean;
  customerTotalPaise?: string | null;
  batches: MoneyBatch[];
  supplierTotals?: Array<{ supplierId: string; supplierName: string; runningTotalPaise: string }>;
  approvals?: FareApproval[];
  invoices?: Array<{ documentId: string; supplierId: string; number: string; docDate: string; totalPaise: string; status: string }>;
  invoiceMissing?: boolean | null;
}

/* ---------- 9.4 other reads ---------- */

export interface FlightPaymentContext {
  /** Still to pay (supplier cost less what an old fare record already paid). */
  amountPaise: string;
  supplierCostPaise?: string;
  legacyPaidPaise?: string;
  supplierName: string;
  runningTotalPaise: string;
  routePreview: PaymentRoute;
  directAllowed: boolean;
  directLimitPaise: string;
  proofs: Array<{ evidenceId: string; fileName: string }>;
}

export interface FlightSupplierOption {
  supplierId: string;
  name: string;
  city: string | null;
  status: string;
  bankDetailsApproved: boolean;
  verification?: 'unverified' | 'verified';
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  rowVersion?: number;
}

export interface FlightFarePreview {
  fareHash: string;
  batchSupplierCostPaise: string;
  batchCustomerTotalPaise: string | null;
  dealSupplierCostAfterPaise: string;
  dealBudgetPaise: string | null;
  overBudget: boolean;
  approval: null | { approvalId: string; status: string };
  costTaskId: string;
}

export interface SectorSummary {
  from: string;
  to: string;
  departDate: string | null;
  departTime: string | null;
  arriveDate?: string | null;
  arriveTime: string | null;
  flightNo: string | null;
  airline?: string | null;
  cabin?: string | null;
  travellers?: string[];
}

export interface DealFlightPendingChange {
  changeId: string;
  changeNo: number;
  kind: ChangeKind;
  remark: string;
  travellers: string[];
  from: SectorSummary[];
  to: SectorSummary[];
  requestedAt: string;
  requestedByName: string | null;
  rowVersion: number;
  canDecide: boolean;
}

export interface DealFlightSummary {
  /** Owner decision R3: blank traveller places this viewer may name (Sales owner, or the branch Manager when no active owner); null otherwise. */
  nameFill?: { versionId: string; slots: Array<{ seq: number; type: PaxType | null }> } | null;
  flights: Array<{
    taskId: string;
    itemNo: number;
    title: string;
    status: FlightStatus;
    assigneeName: string | null;
    unnamedCount: number;
    bookingChanged: boolean;
    current: SectorSummary[];
    pending: DealFlightPendingChange[];
    eTickets?: Array<{ evidenceId: string; fileName: string }>;
  }>;
  transfers: Array<{ transferItemId: string; transferTitle: string; flightTaskId: string; flightCurrent: SectorSummary[] }>;
}

export interface DealFlightHistoryEvent {
  at: string;
  kind: string;
  taskId: string;
  flightTitle: string;
  byName: string | null;
  byYou: boolean;
  note: string | null;
  changeNo: number | null;
}

export interface FlightHomeCounts {
  flightDealsNotTaken: number | null;
  flightDealsMine: number | null;
  flightBookingChanged: number | null;
  flightChangesDecided: number | null;
  flightReadyToFinish: number | null;
  salesFlightChangesToDecide: number | null;
  salesTravellersToName: number | null;
  /** Flight: travellers Sales named on your Deals that have no ticket yet. */
  flightTravellersNamed?: number | null;
  /** Set when exactly one Deal feeds the row (Home then opens that Deal). */
  salesFlightChangesToDecideDealId?: string | null;
  salesTravellersToNameDealId?: string | null;
}

export interface ManagerFlightFareRow {
  approvalId: string;
  dealId: string;
  dealReference: string;
  flightTitles: string[] | string;
  supplierName: string | null;
  batchSupplierCostPaise: string;
  projectedSupplierCostPaise: string;
  budgetPaise: string | null;
  requestedAt: string;
  requestedByName: string | null;
  rowVersion: number;
  canApprove: boolean;
}

/** flight_fare_approval_sets: the exact fare set of a pending or approved Manager request. */
export interface FareApprovalSet {
  approvalId: string;
  approvalNo: number;
  status: 'pending' | 'approved';
  rowVersion: number;
  fareHash: string;
  supplierId: string;
  supplierName: string | null;
  sectorIds: string[];
  travellers: Array<{ seq: number; type: PaxType }>;
  fares: Array<{
    paxType: PaxType;
    basicPaise: string;
    kPaise: string;
    yqPaise: string;
    yrPaise: string;
    otherPaise: string;
    markupPaise: string | null;
    discountPaise: string | null;
    paxCount: number;
  }>;
}
