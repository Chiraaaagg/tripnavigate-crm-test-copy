import type {
  BookingDiff,
  DealFlightSummary,
  FlightChange,
  FlightMoney,
  FlightPaymentContext,
  FlightQueueGroup,
  FlightSector,
  FlightStatus,
  FlightSupplierOption,
  FlightTraveller,
  FlightWorkspace,
  ManagerFlightFareRow,
  ProgressStep,
  SectorTicket,
  WorkspaceFlight,
} from '@/views/flight/types';

/*
 * Synthetic data for the Flight build preview states (fl-). Example names,
 * SYN- Deal references, made-up PNRs, ticket numbers and amounts only; no
 * real customer, airline booking or supplier data.
 */

const id = (n: number, p = 'f') => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DEAL = id(900, 'd');
export const T1 = id(301);
export const T2 = id(302);
const ME = 'Synthetic Flight Jodhpur';

export const TRAVELLERS: FlightTraveller[] = [
  { seq: 1, fullName: 'Example Traveller One', type: 'adult', ageYears: 41, specialNeeds: null, identity: null },
  { seq: 2, fullName: 'Example Traveller Two', type: 'adult', ageYears: 38, specialNeeds: 'Wheelchair at the airport (synthetic)', identity: null },
  { seq: 3, fullName: 'Example Child Three', type: 'child', ageYears: 9, specialNeeds: null, identity: null },
];

export const status = (code: FlightStatus['code'], confirmed = 0, required = 0): FlightStatus => ({
  code,
  confirmed,
  required,
  text: code === 'waiting' ? 'Waiting' : code === 'in_progress' ? `In progress · ${confirmed} of ${required} tickets` : code === 'all_confirmed' ? 'All tickets confirmed' : 'Done · ticket issued',
});

export function ticket(n: number, over: Partial<SectorTicket> = {}): SectorTicket {
  return {
    revisionNo: 1,
    crsType: 'amadeus',
    crsPnr: 'SYNCR1',
    airlinePnr: 'SYNAI7',
    ticketNumber: `098-24100000${String(n).padStart(2, '0')}`,
    batchNo: 1,
    confirmedAt: '2026-11-04T08:30:00Z',
    confirmedByName: ME,
    travellerChanged: false,
    canCorrect: true,
    history: [],
    ...over,
  };
}

function sector(n: number, over: Partial<FlightSector>): FlightSector {
  return {
    sectorId: id(400 + n, 'a'),
    origin: 'booking',
    status: 'active',
    displayState: 'active',
    changeId: null,
    changeNo: null,
    from: 'JDH',
    to: 'BOM',
    departDate: '2026-11-14',
    departTime: '10:35',
    arriveDate: '2026-11-14',
    arriveTime: '12:10',
    airline: 'AI',
    flightNo: 'AI 470',
    cabin: 'Economy',
    rowVersion: 1,
    canFillBlanks: false,
    canAlternate: true,
    canEditScreenshot: false,
    travellers: [1, 2, 3].map((seq) => ({ seq, held: false, heldByChangeNo: null, ticket: null })),
    endedTravellers: [],
    ...over,
  };
}

export const S1 = sector(1, {});
export const S2 = sector(2, { from: 'BOM', to: 'GOI', departTime: '14:20', arriveTime: null, airline: 'IndiGo', flightNo: '6E 5321', canFillBlanks: true });
export const S3 = sector(3, { origin: 'screenshot', from: 'GOI', to: 'JDH', departDate: '2026-11-18', departTime: '16:20', arriveTime: '18:55', arriveDate: '2026-11-18', airline: 'IndiGo', flightNo: '6E 6143', canEditScreenshot: true });

export function progress(current: ProgressStep['key'], subs: Partial<Record<ProgressStep['key'], string>> = {}, withApprovals = false): ProgressStep[] {
  const keys: ProgressStep['key'][] = ['take', ...(withApprovals ? (['approvals'] as const) : []), 'tickets', 'payment', 'etickets', 'done'];
  const at = keys.indexOf(current);
  return keys.map((key, i) => ({ key, state: i < at ? 'done' : i === at ? 'current' : 'todo', sub: subs[key] ?? null }));
}

const booked1: WorkspaceFlight['booked'] = {
  legs: [
    { legNo: 1, from: 'JDH', to: 'BOM', date: '2026-11-14', arrivalDate: null, airline: 'AI', flightNo: 'AI 470', departTime: '10:35', arriveTime: '12:10' },
    { legNo: 2, from: 'BOM', to: 'GOI', date: '2026-11-14', arrivalDate: null, airline: 'IndiGo', flightNo: '6E 5321', departTime: '14:20', arriveTime: null },
  ],
  cabin: 'Economy',
  preferredTime: 'Morning',
  notes: 'Window seats if possible (synthetic).',
  preferences: null,
  assistance: 'Wheelchair for traveller two (synthetic).',
  tripType: 'multi_city',
  isReturn: false,
};

export function flight1(over: Partial<WorkspaceFlight> = {}): WorkspaceFlight {
  return {
    taskId: T1,
    itemNo: 2,
    title: 'JDH → BOM → GOI',
    status: status('in_progress', 0, 6),
    entryMode: 'typed',
    screenshotNote: null,
    screenshots: [],
    basisVersionNo: 2,
    currentVersionNo: 2,
    stateRowVersion: 1,
    bookingChanged: null,
    booked: booked1,
    travellers: TRAVELLERS,
    unnamedCount: 0,
    salesFare: { source: 'item', adultPaise: '1680000', childPaise: '1440000', infantPaise: null, adults: 2, children: 1, infants: 0 },
    sectors: [S1, S2],
    changes: [],
    ...over,
  };
}

export function flight2(over: Partial<WorkspaceFlight> = {}): WorkspaceFlight {
  return {
    taskId: T2,
    itemNo: 3,
    title: 'GOI → JDH',
    status: status('in_progress', 0, 0),
    entryMode: 'screenshot',
    screenshotNote: 'Evening flight, 15 kg bags (synthetic).',
    screenshots: [{ fileId: id(501, 'b'), fileName: 'synthetic-fare-quote.png', mime: 'image/png', sizeBytes: 245760, href: '/preview/flight-ws-files' }],
    basisVersionNo: 2,
    currentVersionNo: 2,
    stateRowVersion: 1,
    bookingChanged: null,
    booked: { legs: [], cabin: 'Economy', preferredTime: null, notes: null, preferences: null, assistance: null, tripType: 'one_way', isReturn: true },
    travellers: TRAVELLERS,
    unnamedCount: 1,
    sectors: [],
    changes: [],
    ...over,
  };
}

export function workspace(over: Partial<FlightWorkspace> = {}): FlightWorkspace {
  return {
    dealId: DEAL,
    dealReference: 'SYN-JOD-901',
    branchName: 'Jodhpur',
    dealKind: 'package',
    tripScope: 'domestic',
    assignee: { name: ME, isYou: true },
    assigneeUserId: id(11, 'e'),
    canWork: true,
    canTake: false,
    canReassign: false,
    reassignCandidates: [],
    status: status('in_progress', 0, 6),
    progress: progress('tickets', { tickets: '0 of 6' }),
    doneIssues: ['travellers_unnamed', 'tickets_pending', 'eticket_missing'],
    canComplete: false,
    flights: [flight1(), flight2()],
    ticketsByPnr: [],
    eTickets: [],
    canUploadETicket: true,
    ...over,
  };
}

export const pendingChange: FlightChange = {
  changeId: id(601, 'c'),
  changeNo: 1,
  kind: 'alternative',
  status: 'pending',
  deciderKind: 'sales_owner',
  deciderName: 'Synthetic Sales Jodhpur',
  remark: 'Earlier flight full for the wheelchair seat (synthetic).',
  travellers: [{ seq: 2, name: 'Example Traveller Two' }],
  fromSectorIds: [S1.sectorId],
  newSectorIds: [id(410, 'a')],
  basisVersionNo: 2,
  requestedAt: '2026-11-04T07:10:00Z',
  requestedByName: ME,
  decidedAt: null,
  decidedByName: null,
  rejectReason: null,
  rowVersion: 1,
  canWithdraw: true,
  needsAck: false,
};

export const pendingSector = sector(10, {
  origin: 'change',
  status: 'pending',
  displayState: 'pending',
  changeId: pendingChange.changeId,
  changeNo: 1,
  airline: 'Vistara',
  flightNo: 'UK 611',
  departTime: '13:05',
  arriveTime: '14:45',
  canAlternate: false,
  travellers: [{ seq: 2, held: false, heldByChangeNo: null, ticket: null }],
});

export const diff: BookingDiff = {
  fromVersionId: id(2, 'b'),
  toVersionId: id(3, 'b'),
  fromVersionNo: 2,
  toVersionNo: 3,
  legs: {
    unchanged: [{ oldLegNo: 1, newLegNo: 1, leg: { from: 'JDH', to: 'BOM', date: '2026-11-14', airline: 'AI', flightNo: 'AI 470', departTime: '10:35', arriveTime: '12:10' } }],
    changed: [
      {
        old: { from: 'BOM', to: 'GOI', date: '2026-11-14', airline: 'IndiGo', flightNo: '6E 5321', departTime: '14:20', arriveTime: null },
        new: { from: 'BOM', to: 'GOI', date: '2026-11-15', airline: 'IndiGo', flightNo: '6E 5327', departTime: '09:10', arriveTime: '10:25' },
      },
    ],
    removed: [],
    added: [],
  },
  passengers: { added: [], removed: [], renamed: [{ seq: 3, oldName: 'Example Child Three', newName: 'Example Child Third', oldType: 'child', newType: 'child' }] },
  otherFields: ['notes'],
  impact: { ticketsOnRemoved: 0, ticketsOfRemovedTravellers: 0, ticketsRenamed: 0, pendingChangesSuperseded: 0, approvedChangesOnChangedLegs: [] },
};

export const SUPPLIERS: FlightSupplierOption[] = [
  { supplierId: id(801, 'c'), name: 'Synthetic Air Consolidator', city: 'Jaipur', status: 'active', bankDetailsApproved: true, verification: 'verified', contactName: 'Example Desk', contactPhone: '+91 90000 00001', contactEmail: 'desk@example.test', rowVersion: 3 },
  { supplierId: id(802, 'c'), name: 'Synthetic Airline Direct', city: null, status: 'active', bankDetailsApproved: false, verification: 'unverified', contactName: null, contactPhone: null, contactEmail: null, rowVersion: 1 },
];

export const BATCH = id(701, 'b');

export function money(over: Partial<FlightMoney> = {}, payment: FlightMoney['batches'][number]['payment'] = { state: 'unpaid', route: null }): FlightMoney {
  return {
    dealKind: 'package',
    budget: { dealPaise: '4200000', tasks: [{ taskId: T1, budgetPaise: '4200000', source: 'estimate' }, { taskId: T2, budgetPaise: null, source: 'none' }] },
    supplierCostPaise: '3360000',
    overBudget: false,
    batches: [
      {
        batchId: BATCH,
        batchNo: 1,
        costTaskId: T1,
        supplierId: SUPPLIERS[0]!.supplierId,
        supplierName: SUPPLIERS[0]!.name,
        sectorIds: [S1.sectorId, S2.sectorId],
        confirmedAt: '2026-11-04T08:30:00Z',
        confirmedByName: ME,
        fares: [
          { paxType: 'adult', basicPaise: '980000', kPaise: '50000', yqPaise: '120000', yrPaise: '20000', otherPaise: '10000', supplierPerPersonPaise: '1180000', paxCount: 2, supplierAmountPaise: '2360000' },
          { paxType: 'child', basicPaise: '800000', kPaise: '50000', yqPaise: '120000', yrPaise: '20000', otherPaise: '10000', supplierPerPersonPaise: '1000000', paxCount: 1, supplierAmountPaise: '1000000' },
        ],
        supplierCostPaise: '3360000',
        payment,
        canPayDirect: payment.state === 'unpaid' || payment.state === 'direct_returned',
        canRequest: payment.state === 'unpaid',
        routePreview: 'direct',
      },
    ],
    approvals: [],
    invoiceMissing: false,
    ...over,
    // No batch yet: no supplier cost either (keeps the fixture honest).
    ...(over.batches && over.batches.length === 0 ? { supplierCostPaise: '0', overBudget: false } : {}),
  };
}

export const ctxDirect: FlightPaymentContext = {
  amountPaise: '3360000',
  supplierName: SUPPLIERS[0]!.name,
  runningTotalPaise: '0',
  routePreview: 'accounts',
  directAllowed: true,
  directLimitPaise: '5000000',
  proofs: [],
};
export const ctxOver: FlightPaymentContext = { ...ctxDirect, amountPaise: '6200000', runningTotalPaise: '3000000', routePreview: 'manager', directAllowed: false };

/** Flight 1 with every traveller ticketed on both sectors. */
export function ticketedFlight1(over: Partial<WorkspaceFlight> = {}): WorkspaceFlight {
  const t = (s: FlightSector, base: number) => ({ ...s, canAlternate: false, canFillBlanks: false, travellers: s.travellers.map((x) => ({ ...x, ticket: ticket(base + x.seq) })) });
  return flight1({ status: status('all_confirmed', 6, 6), sectors: [t(S1, 0), t(S2, 0)], ...over });
}

/** The return flight's PNR (screenshot sector S3), ticketed in batch 2. */
export const PNR_RETURN: FlightWorkspace['ticketsByPnr'][number] = {
  airlinePnr: 'SYN6E9',
  crsType: 'airline_direct',
  crsPnr: null,
  active: true,
  sectors: [{ sectorId: S3.sectorId, departDate: '2026-11-18', departTime: '16:20', flightNo: '6E 6143', from: 'GOI', to: 'JDH', airline: 'IndiGo' }],
  confirmedAt: '2026-11-04T09:10:00Z',
  travellers: TRAVELLERS.map((t) => ({ seq: t.seq, name: t.fullName, type: t.type, ticketNumbers: [`312-24100000${String(10 + t.seq).padStart(2, '0')}`] })),
};

export const PNR_GROUPS: FlightWorkspace['ticketsByPnr'] = [
  {
    airlinePnr: 'SYNAI7',
    crsType: 'amadeus',
    crsPnr: 'SYNCR1',
    active: true,
    sectors: [
      { sectorId: S1.sectorId, departDate: '2026-11-14', departTime: '10:35', flightNo: 'AI 470', from: 'JDH', to: 'BOM', airline: 'AI' },
      { sectorId: S2.sectorId, departDate: '2026-11-14', departTime: '14:20', flightNo: '6E 5321', from: 'BOM', to: 'GOI', airline: 'IndiGo' },
    ],
    confirmedAt: '2026-11-04T08:30:00Z',
    travellers: TRAVELLERS.map((t) => ({ seq: t.seq, name: t.fullName, type: t.type, ticketNumbers: [`098-24100000${String(t.seq).padStart(2, '0')}`] })),
  },
];

export function queueGroups(): FlightQueueGroup[] {
  const chips = { bookingChanged: false, unnamed: 0, changesWaiting: 0, faresWaiting: false, paymentNeeded: false };
  return [
    {
      dealId: DEAL,
      dealReference: 'SYN-JOD-901',
      branchName: 'Jodhpur',
      status: status('in_progress', 2, 9),
      assigneeName: ME,
      assignedToYou: true,
      canTake: false,
      firstDate: '2026-11-14',
      chips: { ...chips, unnamed: 1, changesWaiting: 1 },
      hasChangeDecision: true,
      readyToFinish: false,
      budgetPaise: '4200000',
      travellerCount: 4,
      flights: [
        { taskId: T1, itemNo: 2, title: 'JDH → BOM → GOI', route: 'JDH → BOM → GOI', firstDate: '2026-11-14', status: status('in_progress', 2, 6), entryMode: 'typed' },
        { taskId: T2, itemNo: 3, title: 'GOI → JDH', route: 'GOI → JDH', firstDate: '2026-11-18', status: status('in_progress', 0, 3), entryMode: 'screenshot' },
      ],
    },
    {
      dealId: id(901, 'd'),
      dealReference: 'SYN-JOD-902',
      branchName: 'Jodhpur',
      status: status('waiting'),
      assigneeName: null,
      assignedToYou: false,
      canTake: true,
      firstDate: '2026-11-22',
      chips,
      budgetPaise: '1800000',
      travellerCount: 2,
      flights: [{ taskId: id(311), itemNo: 1, title: 'JDH → DEL', route: 'JDH → DEL', firstDate: '2026-11-22', status: status('waiting'), entryMode: 'typed' }],
    },
    {
      dealId: id(902, 'd'),
      dealReference: 'SYN-JOD-903',
      branchName: 'Jodhpur',
      status: status('waiting'),
      assigneeName: null,
      assignedToYou: false,
      canTake: true,
      firstDate: null,
      chips,
      budgetPaise: null,
      travellerCount: 3,
      flights: [{ taskId: id(312), itemNo: 1, title: 'From screenshot', route: 'From screenshot', firstDate: null, status: status('waiting'), entryMode: 'screenshot' }],
    },
    {
      dealId: id(903, 'd'),
      dealReference: 'SYN-JOD-904',
      branchName: 'Jodhpur',
      status: status('all_confirmed', 2, 2),
      assigneeName: 'Synthetic Flight Colleague',
      assignedToYou: false,
      canTake: false,
      firstDate: '2026-11-09',
      chips: { ...chips, paymentNeeded: true },
      budgetPaise: '900000',
      travellerCount: 1,
      flights: [{ taskId: id(313), itemNo: 1, title: 'UDR → BLR', route: 'UDR → BLR', firstDate: '2026-11-09', status: status('all_confirmed', 2, 2), entryMode: 'typed' }],
    },
  ];
}

export const DEAL_SUMMARY: DealFlightSummary = {
  flights: [
    {
      taskId: T1,
      itemNo: 2,
      title: 'JDH → BOM → GOI',
      status: status('in_progress', 0, 6),
      assigneeName: ME,
      unnamedCount: 0,
      bookingChanged: false,
      current: [
        { from: 'JDH', to: 'BOM', departDate: '2026-11-14', departTime: '10:35', arriveTime: '12:10', flightNo: 'AI 470', airline: 'AI', travellers: ['Example Traveller One', 'Example Traveller Two', 'Example Child Three'] },
        { from: 'BOM', to: 'GOI', departDate: '2026-11-14', departTime: '14:20', arriveTime: null, flightNo: '6E 5321', airline: 'IndiGo', travellers: ['Example Traveller One', 'Example Traveller Two', 'Example Child Three'] },
      ],
      pending: [
        {
          changeId: pendingChange.changeId,
          changeNo: 1,
          kind: 'alternative',
          remark: pendingChange.remark,
          travellers: ['Example Traveller Two'],
          from: [{ from: 'JDH', to: 'BOM', departDate: '2026-11-14', departTime: '10:35', arriveTime: '12:10', flightNo: 'AI 470', airline: 'AI' }],
          to: [{ from: 'JDH', to: 'BOM', departDate: '2026-11-14', departTime: '13:05', arriveTime: '14:45', flightNo: 'UK 611', airline: 'Vistara' }],
          requestedAt: '2026-11-04T07:10:00Z',
          requestedByName: ME,
          rowVersion: 1,
          canDecide: true,
        },
      ],
      eTickets: [],
    },
    {
      taskId: T2,
      itemNo: 3,
      title: 'GOI → JDH',
      status: status('in_progress', 0, 0),
      assigneeName: ME,
      unnamedCount: 1,
      bookingChanged: false,
      current: [],
      pending: [],
      eTickets: [{ evidenceId: id(551, 'e'), fileName: 'synthetic-e-ticket.pdf' }],
    },
  ],
  transfers: [{ transferItemId: id(321), transferTitle: 'Airport pickup, Goa', flightTaskId: T1, flightCurrent: [{ from: 'BOM', to: 'GOI', departDate: '2026-11-14', departTime: '14:20', arriveTime: null, flightNo: '6E 5321', airline: 'IndiGo' }] }],
};

export const FARE_ROWS: ManagerFlightFareRow[] = [
  {
    approvalId: id(651, 'a'),
    dealId: DEAL,
    dealReference: 'SYN-JOD-901',
    flightTitles: ['JDH → BOM → GOI'],
    supplierName: SUPPLIERS[0]!.name,
    batchSupplierCostPaise: '5040000',
    projectedSupplierCostPaise: '5040000',
    budgetPaise: '4200000',
    requestedAt: '2026-11-04T08:05:00Z',
    requestedByName: ME,
    rowVersion: 1,
    canApprove: true,
  },
  {
    approvalId: id(652, 'a'),
    dealId: id(905, 'd'),
    dealReference: 'SYN-JOD-906',
    flightTitles: ['JDH → DEL'],
    supplierName: SUPPLIERS[1]!.name,
    batchSupplierCostPaise: '1200000',
    projectedSupplierCostPaise: '1200000',
    budgetPaise: null,
    requestedAt: '2026-11-04T09:00:00Z',
    requestedByName: 'Synthetic Flight Colleague',
    rowVersion: 1,
    canApprove: false,
  },
];
