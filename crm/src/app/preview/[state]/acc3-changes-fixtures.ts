import type {
  ChangeReviewView,
  ReviewSideView,
  ChangeHistoryView,
  ChangeModeView,
  ChangeRequestListRow,
  ChangeRequestView,
  DealChangeRequestsView,
  ProofOption,
  RemovalChargesView,
  TaskReconfirmationView,
} from '@/views/booking-changes/types';

/*
 * Synthetic fixtures for the change preview states (acc3-changes-): one
 * committed Deal SYN-JOD-301 with two supplier-confirmed hotels (items 1 and
 * 2), a transfer (item 3) not yet booked and an activity (item 4). Names,
 * references and amounts are invented; nothing here is real.
 */

export const DEAL_ID = 'a0003301-0000-4000-8000-000000003301';
const ITEM = (n: number) => `a00034${String(n).padStart(2, '0')}-0000-4000-8000-0000000034${String(n).padStart(2, '0')}`;
const CR = (n: number) => `a00035${String(n).padStart(2, '0')}-0000-4000-8000-0000000035${String(n).padStart(2, '0')}`;
const TASK = (n: number) => `a00036${String(n).padStart(2, '0')}-0000-4000-8000-0000000036${String(n).padStart(2, '0')}`;

const NO_CAN = { resubmit: false, withdraw: false, openVersion: false, submit: false };

export const CONFIRMED_MANAGER: DealChangeRequestsView['confirmed'] = [
  { itemId: ITEM(1), itemNo: 1, serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', department: 'purchase', taskStatus: 'supplier_confirmed', supplierName: 'Synthetic Stays Pvt Ltd', reference: 'SYN-HTL-88412' },
  { itemId: ITEM(2), itemNo: 2, serviceTitle: 'Hotel · Synthetic Fort View, Jodhpur', department: 'purchase', taskStatus: 'supplier_confirmed', supplierName: 'Synthetic Desert Hotels', reference: 'SYN-HTL-11930' },
];
export const CONFIRMED_SALES: DealChangeRequestsView['confirmed'] = CONFIRMED_MANAGER.map((c) => ({ ...c, supplierName: null, reference: null }));

export const REMOVABLE: NonNullable<DealChangeRequestsView['removable']> = [
  { itemId: ITEM(1), itemNo: 1, serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', department: 'purchase', booked: true },
  { itemId: ITEM(2), itemNo: 2, serviceTitle: 'Hotel · Synthetic Fort View, Jodhpur', department: 'purchase', booked: true },
  { itemId: ITEM(3), itemNo: 3, serviceTitle: 'Transfer · Airport to hotel', department: 'purchase', booked: false },
  { itemId: ITEM(4), itemNo: 4, serviceTitle: 'Activity · Synthetic boat ride', department: 'purchase', booked: false },
];

function req(n: number, over: Partial<ChangeRequestView>): ChangeRequestView {
  return {
    id: CR(n),
    refNo: `CR-2026-0000${String(20 + n)}`,
    kind: 'change',
    status: 'requested',
    itemNos: [1],
    changeSummary: 'Check-in at the Udaipur hotel moves from 12 Dec to 13 Dec; one more room for the grandparents.',
    reason: 'The customer changed flights; grandparents join the trip.',
    requestedByName: 'Synthetic Sales Jodhpur',
    requestedAt: '2026-11-13T05:40:00Z',
    decidedByName: null,
    decidedAt: null,
    returnReason: null,
    changeVersionId: null,
    reconfirmations: [],
    closeReason: null,
    rowVersion: 1,
    can: NO_CAN,
    ...over,
  };
}

// Addendum O2: a request is filled in the booking (draft) and sent; the Manager approves that version.
export const REQ_REQUESTED = req(1, { changeVersionId: 'a0003700-0000-4000-8000-000000003700', rowVersion: 3, can: { ...NO_CAN, withdraw: true } });
export const REQ_RETURNED = req(2, {
  status: 'returned',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-13T07:05:00Z',
  returnReason: 'Say which room type the extra room is, and confirm the customer agreed to the new price.',
  changeVersionId: 'a0003703-0000-4000-8000-000000003703',
  rowVersion: 4,
  can: { ...NO_CAN, resubmit: true, submit: true, withdraw: true },
});
/** O2: just started — the change version is not open yet. (Export name kept for the existing states.) */
export const REQ_APPROVED = req(3, {
  status: 'draft',
  rowVersion: 1,
  can: { ...NO_CAN, openVersion: true, resubmit: true, withdraw: true },
});
export const REQ_EDITING = req(4, { ...REQ_APPROVED, id: CR(4), refNo: 'CR-2026-000024', changeVersionId: 'a0003701-0000-4000-8000-000000003701', rowVersion: 3, can: { ...NO_CAN, submit: true, resubmit: true, withdraw: true } });
/** O2: approved by the Manager — suppliers reconfirm. (Export name kept for the existing states.) */
export const REQ_SUBMITTED = req(5, {
  status: 'approved',
  itemNos: [1, 2],
  changeSummary: 'Both hotels move one night later (Udaipur 13–15 Dec, Jodhpur 15–17 Dec).',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-13T07:05:00Z',
  changeVersionId: 'a0003702-0000-4000-8000-000000003702',
  rowVersion: 4,
  reconfirmations: [
    { taskId: TASK(1), serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', status: 'recorded', overBudget: true, refusedReason: null },
    { taskId: TASK(2), serviceTitle: 'Hotel · Synthetic Fort View, Jodhpur', status: 'pending', overBudget: false, refusedReason: null },
  ],
  can: { ...NO_CAN, withdraw: true },
});
export const REQ_NOT_POSSIBLE = req(6, {
  status: 'not_possible',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-09T07:05:00Z',
  requestedAt: '2026-11-09T05:00:00Z',
  closeReason: 'The hotel is full on 13 Dec; it can only keep the original dates.',
  reconfirmations: [{ taskId: TASK(1), serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', status: 'refused', overBudget: false, refusedReason: 'Fully booked on 13 Dec.' }],
});
export const REQ_APPLIED = req(7, {
  status: 'applied',
  kind: 'add_service',
  itemNos: [],
  changeSummary: 'Add an airport transfer on 12 Dec for 4 travellers.',
  reason: 'Customer asked for pick-up after booking.',
  requestedAt: '2026-11-05T05:00:00Z',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-05T06:00:00Z',
});
export const REQ_REMOVE_BOOKED = req(8, {
  kind: 'remove_service',
  changeVersionId: 'a0003704-0000-4000-8000-000000003704',
  itemNos: [2],
  changeSummary: 'Remove the Jodhpur hotel; the family stays with relatives.',
  reason: 'Customer will stay with relatives in Jodhpur.',
  removalRoute: 'cancellation',
  customerChargePaise: '450000',
  charges: [{ department: 'purchase', enteredByName: null, complete: false }],
  can: { ...NO_CAN, withdraw: true },
});
export const REQ_REMOVE_SIMPLE = req(9, {
  kind: 'remove_service',
  status: 'draft',
  itemNos: [4],
  changeSummary: 'Remove the boat ride; the customer does not want it.',
  reason: 'Customer changed their plans for the last day.',
  removalRoute: 'simple',
  customerChargePaise: null,
  can: { ...NO_CAN, openVersion: true, withdraw: true },
});

const base = (over: Partial<DealChangeRequestsView> = {}): DealChangeRequestsView => ({
  dealId: DEAL_ID,
  enabled: true,
  serviceChangesEnabled: true,
  canRequest: true,
  blockedBy: [],
  confirmed: CONFIRMED_SALES,
  requests: [REQ_APPLIED, REQ_NOT_POSSIBLE],
  addableTypes: ['hotel', 'transfer', 'activity', 'car'],
  removable: REMOVABLE,
  ...over,
});

export const DEAL_NONE = base({ requests: [] });
export const DEAL_PAST = base();
export const DEAL_REQUESTED = base({ requests: [REQ_REQUESTED, REQ_APPLIED, REQ_NOT_POSSIBLE] });
export const DEAL_RETURNED = base({ requests: [REQ_RETURNED, REQ_APPLIED] });
export const DEAL_APPROVED = base({ requests: [REQ_APPROVED, REQ_APPLIED] });
export const DEAL_EDITING = base({ requests: [REQ_EDITING, REQ_APPLIED] });
export const DEAL_SUBMITTED = base({ requests: [REQ_SUBMITTED, REQ_APPLIED] });
export const DEAL_REMOVE_BOOKED = base({ requests: [REQ_REMOVE_BOOKED] });
export const DEAL_REMOVE_SIMPLE = base({ requests: [REQ_REMOVE_SIMPLE] });
export const DEAL_OFF = base({ enabled: false, serviceChangesEnabled: false, blockedBy: ['changes_off'], requests: [] });
export const DEAL_BLOCKED = base({ blockedBy: ['refund_open'], requests: [] });
export const DEAL_NOT_COMMITTED = base({ blockedBy: ['not_committed'], confirmed: [], requests: [] });
export const DEAL_MANAGER = base({ confirmed: CONFIRMED_MANAGER, requests: [REQ_SUBMITTED, REQ_APPLIED] });
export const DEAL_ACCOUNTS = base({ canRequest: false, confirmed: CONFIRMED_MANAGER, requests: [{ ...REQ_SUBMITTED, can: NO_CAN }, REQ_APPLIED] });

/* Approvals › Change requests */
function row(r: ChangeRequestView, over: Partial<ChangeRequestListRow> = {}): ChangeRequestListRow {
  return {
    id: r.id,
    refNo: r.refNo,
    dealId: DEAL_ID,
    dealReference: 'SYN-JOD-301',
    dealTitle: 'Synthetic family trip to Udaipur and Jodhpur',
    branchName: 'Jodhpur',
    kind: r.kind,
    status: r.status,
    itemNos: r.itemNos,
    changeSummary: r.changeSummary,
    reason: r.reason,
    requestedByName: r.requestedByName,
    requestedAt: r.requestedAt,
    rowVersion: r.rowVersion,
    removalRoute: r.removalRoute ?? null,
    customerChargePaise: r.customerChargePaise ?? null,
    chargesComplete: r.charges ? r.charges.every((c) => c.complete) : undefined,
    can: { approve: true, return: true },
    ...over,
  };
}

export const ROW_CHANGE = row(REQ_REQUESTED);
export const ROW_ADD = row({ ...REQ_APPLIED, id: CR(10), refNo: 'CR-2026-000030', status: 'requested' }, { dealReference: 'SYN-JOD-305', dealTitle: 'Synthetic honeymoon in Jaisalmer' });
export const ROW_REMOVE_MISSING = row(REQ_REMOVE_BOOKED);
export const ROW_REMOVE_READY = row({ ...REQ_REMOVE_BOOKED, id: CR(11), refNo: 'CR-2026-000032', charges: [{ department: 'purchase', enteredByName: 'Synthetic Purchase Jodhpur', complete: true }] });
export const ROW_SELF = row({ ...REQ_REQUESTED, id: CR(12), refNo: 'CR-2026-000033', requestedByName: 'Synthetic Manager Jodhpur' }, { can: { approve: false, return: false } });

export const CHARGES_MISSING: RemovalChargesView = {
  changeRequestId: ROW_REMOVE_MISSING.id,
  refNo: ROW_REMOVE_MISSING.refNo,
  customerChargePaise: '450000',
  services: [{ itemNo: 2, serviceTitle: 'Hotel · Synthetic Fort View, Jodhpur', department: 'purchase', supplierName: 'Synthetic Desert Hotels', supplierKeepsPaise: null, refundExpectedPaise: null, enteredByName: null, complete: false }],
};
export const CHARGES_READY: RemovalChargesView = {
  ...CHARGES_MISSING,
  changeRequestId: ROW_REMOVE_READY.id,
  refNo: ROW_REMOVE_READY.refNo,
  services: [{ ...CHARGES_MISSING.services[0]!, supplierKeepsPaise: '300000', refundExpectedPaise: '1500000', enteredByName: 'Synthetic Purchase Jodhpur', complete: true }],
};

/* Reconfirm with supplier */
export const PROOFS: ProofOption[] = [{ evidenceId: 'a0003801-0000-4000-8000-000000003801', fileName: 'synthetic-supplier-reconfirmation.pdf', uploadedAt: '2026-11-13T09:00:00Z' }];

export const RECONFIRM_PENDING: TaskReconfirmationView = {
  taskId: TASK(1),
  changeRequest: { refNo: 'CR-2026-000025', status: 'approved' },
  old: {
    details: [
      { key: 'hotelName', label: 'Hotel', value: 'Synthetic Lake Palace, Udaipur' },
      { key: 'checkIn', label: 'Check-in', value: '12 Dec 2026' },
      { key: 'checkOut', label: 'Check-out', value: '14 Dec 2026' },
      { key: 'rooms', label: 'Rooms', value: '1' },
      { key: 'roomType', label: 'Room type', value: 'Deluxe lake view' },
      { key: 'mealPlan', label: 'Meal plan', value: 'Breakfast' },
    ],
    ratePaise: '2400000',
    reference: 'SYN-HTL-88412',
    confirmedAt: '2026-11-02T10:00:00Z',
  },
  new: {
    details: [
      { key: 'hotelName', label: 'Hotel', value: 'Synthetic Lake Palace, Udaipur' },
      { key: 'checkIn', label: 'Check-in', value: '13 Dec 2026' },
      { key: 'checkOut', label: 'Check-out', value: '15 Dec 2026' },
      { key: 'rooms', label: 'Rooms', value: '2' },
      { key: 'roomType', label: 'Room type', value: 'Deluxe lake view' },
      { key: 'mealPlan', label: 'Meal plan', value: 'Breakfast' },
    ],
    changedFields: ['checkIn', 'checkOut', 'rooms'],
  },
  reconfirmation: { id: 'a0003901-0000-4000-8000-000000003901', status: 'pending', newRatePaise: null, supplierFeePaise: null, newReference: null, evidenceId: null, overBudget: false, budgetPaise: '5000000', rowVersion: 1 },
  can: { record: true, refuse: true, approveOverBudget: false },
};
export const RECONFIRM_RECORDED_OVER: TaskReconfirmationView = {
  ...RECONFIRM_PENDING,
  reconfirmation: { ...RECONFIRM_PENDING.reconfirmation, status: 'recorded', newRatePaise: '4900000', supplierFeePaise: '250000', newReference: 'SYN-HTL-88412-B', evidenceId: PROOFS[0]!.evidenceId, overBudget: true, rowVersion: 2 },
  can: { record: false, refuse: false, approveOverBudget: false },
};
export const RECONFIRM_MANAGER = { ...RECONFIRM_RECORDED_OVER, can: { record: false, refuse: false, approveOverBudget: true } };
export const RECONFIRM_RECORDED = { ...RECONFIRM_RECORDED_OVER, reconfirmation: { ...RECONFIRM_RECORDED_OVER.reconfirmation, newRatePaise: '4600000', supplierFeePaise: '0', overBudget: false } };
export const RECONFIRM_VOID: TaskReconfirmationView = { ...RECONFIRM_RECORDED, changeRequest: { refNo: 'CR-2026-000025', status: 'withdrawn' }, reconfirmation: { ...RECONFIRM_RECORDED.reconfirmation, status: 'void' } };
export const RECONFIRM_REFUSED: TaskReconfirmationView = { ...RECONFIRM_PENDING, changeRequest: { refNo: 'CR-2026-000025', status: 'not_possible' }, reconfirmation: { ...RECONFIRM_PENDING.reconfirmation, status: 'refused' }, can: { record: false, refuse: false, approveOverBudget: false } };

/* History of changes */
export const HISTORY_MANAGER: ChangeHistoryView = {
  versions: [
    { versionNo: 1, status: 'superseded', confirmedAt: '2026-10-28T09:00:00Z', changedFields: [], changeRequest: null },
    { versionNo: 2, status: 'superseded', confirmedAt: '2026-11-05T06:30:00Z', changedFields: ['serviceAdded', 'sellingTotal', 'paymentPlan'], changeRequest: { refNo: 'CR-2026-000027', kind: 'add_service', requestedByName: 'Synthetic Sales Jodhpur', decidedByName: 'Synthetic Manager Jodhpur' } },
    { versionNo: 3, status: 'confirmed', confirmedAt: '2026-11-13T11:00:00Z', changedFields: ['checkIn', 'checkOut', 'rooms', 'sellingTotal'], changeRequest: { refNo: 'CR-2026-000025', kind: 'change', requestedByName: 'Synthetic Sales Jodhpur', decidedByName: 'Synthetic Manager Jodhpur' } },
  ],
  confirmations: [
    { serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', confirmationNo: 1, supplierName: 'Synthetic Stays Pvt Ltd', reference: 'SYN-HTL-88412', confirmedByName: 'Synthetic Purchase Jodhpur', confirmedAt: '2026-11-02T10:00:00Z', amountPaise: '2400000', changeFeePaise: null },
    { serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', confirmationNo: 2, supplierName: 'Synthetic Stays Pvt Ltd', reference: 'SYN-HTL-88412-B', confirmedByName: 'Synthetic Purchase Jodhpur', confirmedAt: '2026-11-13T11:00:00Z', amountPaise: '4850000', changeFeePaise: '250000' },
  ],
};
export const HISTORY_SALES: ChangeHistoryView = { ...HISTORY_MANAGER, confirmations: HISTORY_MANAGER.confirmations.map((c) => ({ ...c, amountPaise: null, changeFeePaise: null })) };
export const HISTORY_PURCHASE: ChangeHistoryView = {
  versions: HISTORY_MANAGER.versions.map((v) => ({ ...v, changedFields: v.changedFields.filter((f) => f !== 'sellingTotal' && f !== 'paymentPlan') })),
  confirmations: HISTORY_SALES.confirmations,
};

/* Change mode */
export const CHANGE_MODE: ChangeModeView = {
  changeRequestId: REQ_EDITING.id,
  refNo: REQ_EDITING.refNo,
  kind: 'change',
  changeSummary: REQ_EDITING.changeSummary,
  requestItemIds: [ITEM(1)],
  changedItemIds: [ITEM(1)],
  itemNos: { [ITEM(1)]: 1, [ITEM(2)]: 2, [ITEM(3)]: 3, [ITEM(4)]: 4 },
  contentHash: 'b'.repeat(64),
  canSubmit: true,
};
export const CHANGE_MODE_OUTSIDE: ChangeModeView = { ...CHANGE_MODE, changedItemIds: [ITEM(1), ITEM(3)] };
export const CHANGE_MODE_NOTHING: ChangeModeView = { ...CHANGE_MODE, changedItemIds: [] };
export const ITEM_IDS = { one: ITEM(1), two: ITEM(2), three: ITEM(3) };

/* Addendum O2: the Manager's side-by-side review */
const SIDE_BASE: ReviewSideView = {
  versionNo: 2,
  tripStart: '2026-12-11',
  tripEnd: '2026-12-17',
  sellingTotalPaise: '18500000',
  plan: [
    { seq: 1, label: 'Advance', amountPaise: '5000000', dueDate: '2026-11-10' },
    { seq: 2, label: 'Balance', amountPaise: '13500000', dueDate: '2026-12-01' },
  ],
  services: [
    { itemId: ITEM(1), itemNo: 1, serviceType: 'hotel', serviceTitle: 'Hotel · Synthetic Lake Palace, Udaipur', budgetPaise: '4500000', facts: [
      { key: 'checkIn', label: 'Check-in', value: '2026-12-12' },
      { key: 'checkOut', label: 'Check-out', value: '2026-12-14' },
      { key: 'rooms', label: 'Rooms', value: '2' },
      { key: 'roomType', label: 'Room type', value: 'Deluxe lake view' },
      { key: 'childAges', label: 'Children\u2019s ages', value: '6, 9' },
    ] },
    { itemId: ITEM(2), itemNo: 2, serviceType: 'hotel', serviceTitle: 'Hotel · Synthetic Fort View, Jodhpur', budgetPaise: '3600000', facts: [
      { key: 'checkIn', label: 'Check-in', value: '2026-12-14' },
      { key: 'checkOut', label: 'Check-out', value: '2026-12-17' },
      { key: 'rooms', label: 'Rooms', value: '2' },
    ] },
  ],
};
const SIDE_NEW: ReviewSideView = {
  ...SIDE_BASE,
  versionNo: 3,
  tripStart: '2026-12-11',
  tripEnd: '2026-12-17',
  sellingTotalPaise: '21500000',
  plan: [
    { seq: 1, label: 'Advance', amountPaise: '5000000', dueDate: '2026-11-10' },
    { seq: 2, label: 'Balance', amountPaise: '16500000', dueDate: '2026-12-01' },
  ],
  services: [
    { ...SIDE_BASE.services[0]!, facts: [
      { key: 'checkIn', label: 'Check-in', value: '2026-12-13' },
      { key: 'checkOut', label: 'Check-out', value: '2026-12-14' },
      { key: 'rooms', label: 'Rooms', value: '3' },
      { key: 'roomType', label: 'Room type', value: 'Deluxe lake view' },
      { key: 'childAges', label: 'Children\u2019s ages', value: '6, 9' },
    ] },
    SIDE_BASE.services[1]!,
    { itemId: ITEM(3), itemNo: 3, serviceType: 'transfer', serviceTitle: 'Car · Airport pick-up, Udaipur', budgetPaise: '300000', facts: [
      { key: 'date', label: 'Date', value: '2026-12-13' },
      { key: 'pickup', label: 'Pick-up', value: 'Udaipur airport' },
    ] },
  ],
};
export const REVIEW_CHANGE: ChangeReviewView = {
  changeRequestId: REQ_REQUESTED.id,
  refNo: REQ_REQUESTED.refNo,
  kind: 'change',
  status: 'requested',
  rowVersion: 3,
  removalRoute: null,
  customerChargePaise: null,
  base: SIDE_BASE,
  proposed: SIDE_NEW,
  changedItemIds: [ITEM(1)],
  changedFields: ['Check-in', 'Rooms', 'Selling total', 'Payment plan'],
  sentVersionCurrent: true,
  canDecide: true,
};
export const REVIEW_STALE: ChangeReviewView = { ...REVIEW_CHANGE, sentVersionCurrent: false, canDecide: false };
export const REVIEW_NOT_FILLED: ChangeReviewView = { ...REVIEW_CHANGE, proposed: null, changedItemIds: [], changedFields: [], canDecide: false };
export const REVIEW_REMOVE: ChangeReviewView = {
  ...REVIEW_CHANGE,
  changeRequestId: ROW_REMOVE_READY.id,
  refNo: ROW_REMOVE_READY.refNo,
  kind: 'remove_service',
  removalRoute: 'cancellation',
  customerChargePaise: '450000',
  proposed: { ...SIDE_BASE, versionNo: 3, sellingTotalPaise: '15450000', plan: [{ seq: 1, label: 'Advance', amountPaise: '5000000', dueDate: '2026-11-10' }, { seq: 2, label: 'Balance', amountPaise: '10450000', dueDate: '2026-12-01' }], services: [SIDE_BASE.services[0]!] },
  changedItemIds: [ITEM(2)],
  changedFields: ['Service removed', 'Selling total', 'Payment plan'],
};
export const RECONFIRM_PENDING_UPLOAD: TaskReconfirmationView = { ...RECONFIRM_PENDING, can: { ...RECONFIRM_PENDING.can, uploadProof: true } };
