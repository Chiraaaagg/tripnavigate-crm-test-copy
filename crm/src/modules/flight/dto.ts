import { z } from 'zod';

/**
 * Flight workspace DTO schemas (Flight build contract, sections 9.1, 9.2 and
 * 9.4; migration 20261201000120_flight_workspace_reads.sql). Every key the
 * database returns is listed here: zod strips unknown keys, so a key missing
 * from a schema is a silent defect. No schema in this file has a money key;
 * flight money lives in money-dto.ts (Track B).
 *
 * Pure module (no server imports): the screens import the types through
 * contracts.ts.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const timestamp = z.string().min(1);
const name = z.string().min(1).max(200);
const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const FLIGHT_STATUS_CODES = ['waiting', 'in_progress', 'all_confirmed', 'done'] as const;
export const FLIGHT_CRS_CODES = ['amadeus', 'galileo', 'sabre', 'airline_direct', 'other'] as const;
export const FLIGHT_CHANGE_KINDS = ['alternative', 'added_instead', 'added_extra', 'passenger_itinerary'] as const;
export const FLIGHT_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn', 'superseded'] as const;
export const FLIGHT_DECIDER_KINDS = ['sales_owner', 'branch_manager', 'flight_owner'] as const;
export const FLIGHT_SECTOR_STATUSES = ['active', 'pending', 'rejected', 'withdrawn', 'superseded', 'booking_removed'] as const;
export const FLIGHT_SECTOR_DISPLAY_STATES = [...FLIGHT_SECTOR_STATUSES, 'replaced'] as const;
export const FLIGHT_PROGRESS_KEYS = ['take', 'approvals', 'tickets', 'payment', 'etickets', 'done'] as const;
export const FLIGHT_ENDED_REASONS = ['change_approved', 'change_rejected', 'change_withdrawn', 'change_superseded',
  'booking_changed', 'traveller_removed', 'screenshot_replaced'] as const;
export const FLIGHT_DONE_ISSUES = ['booking_changed', 'travellers_unnamed', 'traveller_without_flight', 'change_pending',
  'tickets_pending', 'traveller_changed', 'fare_approval_pending', 'payment_missing', 'payment_returned', 'eticket_missing'] as const;

const PAX = z.enum(['adult', 'child', 'infant']);
const CRS = z.enum(FLIGHT_CRS_CODES);

export const FlightStatusSchema = z.object({
  code: z.enum(FLIGHT_STATUS_CODES),
  text: z.string().min(1),
  confirmed: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// 9.1 flight_queue
// ---------------------------------------------------------------------------

export const FlightQueueFlightSchema = z.object({
  taskId: z.uuid(),
  itemNo: z.number().int().positive(),
  title: z.string(),
  route: z.string(),
  firstDate: isoDate.nullable(),
  status: FlightStatusSchema,
  entryMode: z.enum(['typed', 'screenshot']),
});

export const FlightQueueGroupSchema = z.object({
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: z.string(),
  status: FlightStatusSchema,
  assigneeName: name.nullable(),
  assignedToYou: z.boolean(),
  canTake: z.boolean(),
  firstDate: isoDate.nullable(),
  /** 20261201000180: a decided change on the caller's flights not yet seen (the Deals behind flightChangesDecided). */
  hasChangeDecision: z.boolean(),
  /** 20261201000180: the caller works the Deal and the done checklist passes (the Deals behind flightReadyToFinish). */
  readyToFinish: z.boolean(),
  chips: z.object({
    bookingChanged: z.boolean(),
    unnamed: z.number().int().nonnegative(),
    changesWaiting: z.number().int().nonnegative(),
    faresWaiting: z.boolean(),
    paymentNeeded: z.boolean(),
  }),
  /** Deal flight budget (F and M only; every reader of this list is one of them). */
  budgetPaise: paise.nullable(),
  travellerCount: z.number().int().nonnegative(),
  flights: z.array(FlightQueueFlightSchema),
});

export const FlightQueueSchema = z.object({ groups: z.array(FlightQueueGroupSchema) });

// ---------------------------------------------------------------------------
// 9.2 flight_workspace
// ---------------------------------------------------------------------------

export const BookedLegSchema = z.object({
  legNo: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  date: z.string().nullable(),
  arrivalDate: z.string().nullable(),
  airline: z.string().nullable(),
  flightNo: z.string().nullable(),
  departTime: z.string().nullable(),
  arriveTime: z.string().nullable(),
});

export const BookingDiffSchema = z.object({
  fromVersionId: z.uuid(),
  toVersionId: z.uuid(),
  fromVersionNo: z.number().int().positive(),
  toVersionNo: z.number().int().positive(),
  legs: z.object({
    unchanged: z.array(z.object({ oldLegNo: z.number().int(), newLegNo: z.number().int(), leg: BookedLegSchema })),
    changed: z.array(z.object({ oldLegNo: z.number().int(), newLegNo: z.number().int(), old: BookedLegSchema, new: BookedLegSchema })),
    removed: z.array(z.object({ oldLegNo: z.number().int(), old: BookedLegSchema })),
    added: z.array(z.object({ newLegNo: z.number().int(), new: BookedLegSchema })),
  }),
  cabin: z.object({ old: z.string().nullable(), new: z.string().nullable() }),
  entryMode: z.object({ old: z.enum(['typed', 'screenshot']), new: z.enum(['typed', 'screenshot']) }),
  screenshots: z.object({ oldCount: z.number().int().nonnegative(), newCount: z.number().int().nonnegative() }),
  passengers: z.object({
    added: z.array(z.object({ seq: z.number().int(), name: z.string(), type: PAX })),
    removed: z.array(z.object({ seq: z.number().int(), name: z.string(), type: PAX })),
    renamed: z.array(z.object({ seq: z.number().int(), oldName: z.string(), newName: z.string(), oldType: PAX, newType: PAX })),
  }),
  otherFields: z.array(z.string()),
  impact: z.object({
    ticketsOnRemoved: z.number().int().nonnegative(),
    ticketsOfRemovedTravellers: z.number().int().nonnegative(),
    ticketsRenamed: z.number().int().nonnegative(),
    pendingChangesSuperseded: z.number().int().nonnegative(),
    approvedChangesOnChangedLegs: z.array(z.object({ changeNo: z.number().int().positive() })),
  }),
});

export const FlightTravellerSchema = z.object({
  seq: z.number().int().min(1).max(100),
  fullName: z.string(),
  type: PAX,
  ageYears: z.number().int().nullable(),
  specialNeeds: z.string().nullable(),
  /** Only for the Flight assignee on international trips (existing identity rule). */
  identity: z.object({
    dateOfBirth: isoDate.nullable(),
    nationality: z.string().nullable(),
    passportNumber: z.string().nullable(),
    passportExpiry: isoDate.nullable(),
  }).optional(),
});

export const TicketRevisionSchema = z.object({
  revisionNo: z.number().int().positive(),
  crsType: CRS,
  crsPnr: z.string().nullable(),
  airlinePnr: z.string(),
  ticketNumber: z.string(),
  reason: z.string().nullable(),
  at: timestamp,
  byName: name.nullable(),
});

export const SectorTicketSchema = z.object({
  revisionNo: z.number().int().positive(),
  crsType: CRS,
  crsPnr: z.string().nullable(),
  airlinePnr: z.string(),
  ticketNumber: z.string(),
  batchNo: z.number().int().positive().nullable(),
  confirmedAt: timestamp,
  confirmedByName: name.nullable(),
  travellerChanged: z.boolean(),
  canCorrect: z.boolean(),
  history: z.array(TicketRevisionSchema),
});

export const FlightSectorSchema = z.object({
  sectorId: z.uuid(),
  origin: z.enum(['booking', 'screenshot', 'change']),
  status: z.enum(FLIGHT_SECTOR_STATUSES),
  displayState: z.enum(FLIGHT_SECTOR_DISPLAY_STATES),
  changeId: z.uuid().nullable(),
  changeNo: z.number().int().positive().nullable(),
  from: z.string(),
  to: z.string(),
  departDate: isoDate,
  departTime: clock.nullable(),
  arriveDate: isoDate.nullable(),
  arriveTime: clock.nullable(),
  airline: z.string().nullable(),
  flightNo: z.string().nullable(),
  cabin: z.string().nullable(),
  rowVersion: z.number().int().positive(),
  canFillBlanks: z.boolean(),
  canAlternate: z.boolean(),
  canEditScreenshot: z.boolean(),
  travellers: z.array(z.object({
    seq: z.number().int(),
    held: z.boolean(),
    heldByChangeNo: z.number().int().positive().nullable(),
    ticket: SectorTicketSchema.nullable(),
  })),
  endedTravellers: z.array(z.object({ seq: z.number().int(), reason: z.enum(FLIGHT_ENDED_REASONS), at: timestamp })),
});

export const FlightChangeSchema = z.object({
  changeId: z.uuid(),
  changeNo: z.number().int().positive(),
  kind: z.enum(FLIGHT_CHANGE_KINDS),
  status: z.enum(FLIGHT_CHANGE_STATUSES),
  deciderKind: z.enum(FLIGHT_DECIDER_KINDS),
  deciderName: name.nullable(),
  remark: z.string(),
  travellers: z.array(z.object({ seq: z.number().int(), name: z.string().nullable() })),
  fromSectorIds: z.array(z.uuid()),
  newSectorIds: z.array(z.uuid()),
  basisVersionNo: z.number().int().positive(),
  requestedAt: timestamp,
  requestedByName: name.nullable(),
  decidedAt: timestamp.nullable(),
  decidedByName: name.nullable(),
  rejectReason: z.string().nullable(),
  rowVersion: z.number().int().positive(),
  canWithdraw: z.boolean(),
  needsAck: z.boolean(),
});

export const WorkspaceFlightSchema = z.object({
  taskId: z.uuid(),
  itemNo: z.number().int().positive(),
  title: z.string(),
  status: FlightStatusSchema,
  entryMode: z.enum(['typed', 'screenshot']),
  screenshotNote: z.string().nullable(),
  screenshots: z.array(z.object({ fileId: z.uuid(), fileName: z.string(), mime: z.string(), sizeBytes: z.number().int() })),
  basisVersionNo: z.number().int().positive().nullable(),
  currentVersionNo: z.number().int().positive(),
  stateRowVersion: z.number().int().positive().nullable(),
  bookingChanged: BookingDiffSchema.nullable(),
  booked: z.object({
    legs: z.array(BookedLegSchema),
    cabin: z.string().nullable(),
    preferredTime: z.string().nullable(),
    notes: z.string().nullable(),
    preferences: z.string().nullable(),
    assistance: z.string().nullable(),
    tripType: z.string().nullable(),
    isReturn: z.boolean().nullable(),
  }),
  travellers: z.array(FlightTravellerSchema),
  unnamedCount: z.number().int().nonnegative(),
  /**
   * 20261201000140: the Sales fare estimate of this flight per person by type (Details "Sales fare
   * breakup"); 'item' = this flight's own estimate, 'all_flights' = the booking's fare for all flights.
   * A cost-side estimate, never a selling price or markup. null = none.
   */
  salesFare: z.object({
    source: z.enum(['item', 'all_flights']),
    adultPaise: paise.nullable(),
    childPaise: paise.nullable(),
    infantPaise: paise.nullable(),
    adults: z.number().int().nonnegative(),
    children: z.number().int().nonnegative(),
    infants: z.number().int().nonnegative(),
  }).nullable(),
  sectors: z.array(FlightSectorSchema),
  changes: z.array(FlightChangeSchema),
});

export const PnrGroupSchema = z.object({
  airlinePnr: z.string(),
  crsType: CRS,
  crsPnr: z.string().nullable(),
  active: z.boolean(),
  sectors: z.array(z.object({
    sectorId: z.uuid(), departDate: isoDate, departTime: clock.nullable(), flightNo: z.string().nullable(), from: z.string(), to: z.string(),
  })),
  confirmedAt: timestamp,
  travellers: z.array(z.object({ seq: z.number().int(), name: z.string(), type: PAX, ticketNumbers: z.array(z.string()) })),
});

export const ETicketSchema = z.object({
  evidenceId: z.uuid(),
  taskId: z.uuid(),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  storedAt: timestamp,
  uploadedByName: name.nullable(),
});

export const FlightWorkspaceSchema = z.object({
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: z.string(),
  dealKind: z.enum(['package', 'flight_only']),
  tripScope: z.string().nullable(),
  assignee: z.object({ name: name.nullable(), isYou: z.boolean() }),
  canWork: z.boolean(),
  canTake: z.boolean(),
  canReassign: z.boolean(),
  /** 20261201000140: the Flight person's user id, only for the branch Manager who may reassign (else null). */
  assigneeUserId: z.uuid().nullable(),
  reassignCandidates: z.array(z.object({ userId: z.uuid(), name })),
  status: FlightStatusSchema,
  progress: z.array(z.object({ key: z.enum(FLIGHT_PROGRESS_KEYS), state: z.enum(['done', 'current', 'todo']), sub: z.string().nullable() })),
  /** Flight assignee only (null for other readers). Unknown tokens a newer database adds are dropped. */
  doneIssues: z.array(z.string()).nullable().transform((v) => (v ?? []).filter((t): t is FlightDoneIssue => (FLIGHT_DONE_ISSUES as readonly string[]).includes(t))),
  canComplete: z.boolean(),
  completedAt: timestamp.nullable(),
  completedByName: name.nullable(),
  flights: z.array(WorkspaceFlightSchema),
  ticketsByPnr: z.array(PnrGroupSchema),
  eTickets: z.array(ETicketSchema),
  canUploadETicket: z.boolean(),
});

// ---------------------------------------------------------------------------
// 9.4 Deal page reads and Home counts
// ---------------------------------------------------------------------------

export const SectorSummarySchema = z.object({
  sectorId: z.uuid().optional(),
  from: z.string(),
  to: z.string(),
  departDate: z.string().nullable(),
  departTime: z.string().nullable(),
  arriveDate: z.string().nullable(),
  arriveTime: z.string().nullable(),
  airline: z.string().nullable().optional(),
  flightNo: z.string().nullable(),
  cabin: z.string().nullable(),
  travellers: z.array(z.string()).optional(),
});

export const DealFlightSummarySchema = z.object({
  /**
   * 20261201000190 (R3, Addendum 2): blank traveller names the caller may fill on the accepted booking
   * (the Deal's active Sales owner; the branch Manager only without one). null for every other reader.
   * slots: one per missing name, with the seq to post and the missing type (null when the party counts
   * are not recorded: the person chooses). An empty list = nothing left to fill.
   */
  nameFill: z.object({
    versionId: z.uuid(),
    slots: z.array(z.object({ seq: z.number().int().min(1).max(100), type: PAX.nullable() })),
  }).nullable(),
  flights: z.array(z.object({
    taskId: z.uuid(),
    itemNo: z.number().int().positive(),
    title: z.string(),
    status: FlightStatusSchema,
    assigneeName: name.nullable(),
    unnamedCount: z.number().int().nonnegative(),
    bookingChanged: z.boolean(),
    current: z.array(SectorSummarySchema),
    pending: z.array(z.object({
      changeId: z.uuid(),
      changeNo: z.number().int().positive(),
      kind: z.enum(FLIGHT_CHANGE_KINDS),
      remark: z.string(),
      travellers: z.array(z.string()),
      from: z.array(SectorSummarySchema),
      to: z.array(SectorSummarySchema),
      requestedAt: timestamp,
      requestedByName: name.nullable(),
      rowVersion: z.number().int().positive(),
      canDecide: z.boolean(),
    })),
    /** Sales owner, branch Manager and Accounts only ([] for other readers). */
    eTickets: z.array(z.object({ evidenceId: z.uuid(), fileName: z.string() })),
  })),
  transfers: z.array(z.object({
    transferItemId: z.uuid(),
    transferTitle: z.string(),
    flightTaskId: z.uuid(),
    flightCurrent: z.array(SectorSummarySchema),
  })),
});

export const FLIGHT_HISTORY_KINDS = [
  'created', 'taken', 'released', 'reassigned', 'completed', 'booking_change_applied', 'sectors_entered', 'sector_details_filled',
  'change_submitted', 'change_approved', 'change_rejected', 'change_withdrawn', 'tickets_confirmed', 'ticket_corrected',
  'fare_approval_requested', 'fare_approval_approved', 'fare_approval_returned', 'fare_approval_withdrawn',
  'direct_payment_recorded', 'payment_requested', 'payment_resubmitted', 'payment_cancelled', 'payment_approved',
  'payment_returned', 'payment_recorded', 'payment_verified', 'file_added', 'file_removed', 'cost_recorded',
  'sent_to_accounts', 'accounts_accepted', 'accounts_returned',
] as const;
export type FlightHistoryKind = (typeof FLIGHT_HISTORY_KINDS)[number];

const DealHistoryEventSchema = z.object({
  at: timestamp,
  kind: z.enum(FLIGHT_HISTORY_KINDS),
  taskId: z.uuid(),
  flightTitle: z.string().nullable(),
  byName: name.nullable().catch(null),
  byYou: z.boolean().catch(false),
  note: z.string().max(500).nullable().catch(null),
  changeNo: z.number().int().positive().nullable().catch(null),
});

export const DealFlightHistorySchema = z.object({
  events: z
    .array(z.unknown())
    .max(200)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = DealHistoryEventSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  truncated: z.boolean(),
});

const count = z.number().int().nonnegative().nullable();
export const FlightHomeCountsSchema = z.object({
  flightDealsNotTaken: count,
  flightDealsMine: count,
  flightBookingChanged: count,
  flightChangesDecided: count,
  flightReadyToFinish: count,
  /** 20261201000190 (R3): travellers Sales named after the booking who have no ticket yet on the caller's flights. */
  flightTravellersNamed: count,
  salesFlightChangesToDecide: count,
  salesTravellersToName: count,
  /** 20261201000180: the Deal when exactly one Deal feeds the row, else null. */
  salesFlightChangesToDecideDealId: z.uuid().nullable(),
  salesTravellersToNameDealId: z.uuid().nullable(),
});

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

const outcome = z.enum(['created', 'updated', 'existing']);

export const GroupClaimResultSchema = z.object({
  dealId: z.uuid(), taskIds: z.array(z.uuid()), claimedTaskIds: z.array(z.uuid()), outcome,
});
export const GroupReassignResultSchema = z.object({ dealId: z.uuid(), taskIds: z.array(z.uuid()), toUserId: z.uuid(), outcome });
export const BookingChangeApplyResultSchema = z.object({
  taskId: z.uuid(), fromVersionNo: z.number().int(), toVersionNo: z.number().int(), keptSectors: z.number().int(),
  removedSectors: z.number().int(), addedSectors: z.number().int(), flaggedTickets: z.number().int(),
  stateRowVersion: z.number().int(), outcome,
});
export const ScreenshotSaveResultSchema = z.object({ taskId: z.uuid(), sectorIds: z.array(z.uuid()), stateRowVersion: z.number().int(), outcome });
export const FillBlanksResultSchema = z.object({ sectorId: z.uuid(), rowVersion: z.number().int(), fields: z.array(z.string()), outcome });
export const ChangeSubmitResultSchema = z.object({
  changeId: z.uuid(), changeNo: z.number().int(), status: z.enum(FLIGHT_CHANGE_STATUSES), deciderKind: z.enum(FLIGHT_DECIDER_KINDS),
  sectorIds: z.array(z.uuid()), rowVersion: z.number().int(), outcome,
});
export const ChangeDecisionResultSchema = z.object({
  changeId: z.uuid(), changeNo: z.number().int(), status: z.enum(FLIGHT_CHANGE_STATUSES), rowVersion: z.number().int(), outcome,
});
export const ChangeAckResultSchema = z.object({ changeId: z.uuid(), status: z.enum(FLIGHT_CHANGE_STATUSES), outcome });
export const TicketCorrectResultSchema = z.object({
  revisionId: z.uuid(), sectorId: z.uuid(), travellerSeq: z.number().int(), revisionNo: z.number().int(), outcome,
});
export const TravellerNameFillResultSchema = z.object({
  dealId: z.uuid(), versionId: z.uuid(), seq: z.number().int(), type: PAX, flightItemCount: z.number().int().nonnegative(), outcome,
});
export const GroupCompleteResultSchema = z.object({ dealId: z.uuid(), taskIds: z.array(z.uuid()), status: z.literal('completed'), outcome });
export const EvidenceBegunSchema = z.object({ evidenceId: z.uuid(), objectPath: z.string().min(1) });
export const EvidenceFinishedSchema = z.object({ evidenceId: z.uuid(), status: z.enum(['pending_upload', 'stored', 'failed', 'removed']) });
export const EvidenceDownloadSchema = z.object({ objectPath: z.string().min(1), fileName: z.string().min(1), mime: z.string().min(1) });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlightDoneIssue = (typeof FLIGHT_DONE_ISSUES)[number];
export type FlightStatusDTO = z.output<typeof FlightStatusSchema>;
export type FlightQueueDTO = z.output<typeof FlightQueueSchema>;
export type FlightQueueGroupDTO = z.output<typeof FlightQueueGroupSchema>;
export type FlightQueueFlightDTO = z.output<typeof FlightQueueFlightSchema>;
export type FlightWorkspaceDTO = z.output<typeof FlightWorkspaceSchema>;
export type WorkspaceFlightDTO = z.output<typeof WorkspaceFlightSchema>;
export type FlightSectorDTO = z.output<typeof FlightSectorSchema>;
export type SectorTicketDTO = z.output<typeof SectorTicketSchema>;
export type FlightChangeDTO = z.output<typeof FlightChangeSchema>;
export type BookingDiffDTO = z.output<typeof BookingDiffSchema>;
export type BookedLegDTO = z.output<typeof BookedLegSchema>;
export type FlightTravellerDTO = z.output<typeof FlightTravellerSchema>;
export type SalesFareDTO = WorkspaceFlightDTO['salesFare'];
export type PnrGroupDTO = z.output<typeof PnrGroupSchema>;
export type ETicketDTO = z.output<typeof ETicketSchema>;
export type SectorSummaryDTO = z.output<typeof SectorSummarySchema>;
export type DealFlightSummaryDTO = z.output<typeof DealFlightSummarySchema>;
export type DealFlightHistoryDTO = z.output<typeof DealFlightHistorySchema>;
export type DealFlightHistoryEventDTO = DealFlightHistoryDTO['events'][number];
export type FlightHomeCountsDTO = z.output<typeof FlightHomeCountsSchema>;
export type GroupClaimResult = z.output<typeof GroupClaimResultSchema>;
export type GroupReassignResult = z.output<typeof GroupReassignResultSchema>;
export type BookingChangeApplyResult = z.output<typeof BookingChangeApplyResultSchema>;
export type ScreenshotSaveResult = z.output<typeof ScreenshotSaveResultSchema>;
export type FillBlanksResult = z.output<typeof FillBlanksResultSchema>;
export type ChangeSubmitResult = z.output<typeof ChangeSubmitResultSchema>;
export type ChangeDecisionResult = z.output<typeof ChangeDecisionResultSchema>;
export type ChangeAckResult = z.output<typeof ChangeAckResultSchema>;
export type TicketCorrectResult = z.output<typeof TicketCorrectResultSchema>;
export type GroupCompleteResult = z.output<typeof GroupCompleteResultSchema>;
export type TravellerNameFillResult = z.output<typeof TravellerNameFillResultSchema>;
