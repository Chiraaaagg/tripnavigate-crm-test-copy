import type {
  ContractSupplierChoice,
  RateContractDetail,
  RateContractLookup,
  RateContractRow,
  RateLineView,
  RateSheetImportSummary,
  RoomTypeView,
} from '@/views/rate-contracts/types';

/*
 * Synthetic fixtures for the rate contract preview states (acc3-rates-): an
 * invented Udaipur lake hotel sold by an invented direct supplier, two
 * seasons, a weekend rate, one blackout week and an earlier version. Names,
 * numbers and dates are invented; nothing here is real.
 */

const id = (n: number) => `a0003${String(500 + n)}-0000-4000-8000-000000003${String(500 + n)}`;

export const ROOM_TYPES: RoomTypeView[] = [
  { roomTypeId: id(1), name: 'Deluxe room', rowVersion: 1, inUse: true },
  { roomTypeId: id(2), name: 'Lake view suite', rowVersion: 1, inUse: true },
  { roomTypeId: id(3), name: 'Family room', rowVersion: 1, inUse: false },
];

const line = (n: number, over: Partial<RateLineView>): RateLineView => ({
  lineId: id(20 + n),
  seasonFrom: '2026-12-01',
  seasonTo: '2027-03-31',
  roomTypeId: ROOM_TYPES[0]!.roomTypeId,
  roomTypeName: ROOM_TYPES[0]!.name,
  mealPlan: 'CP',
  ratePaise: '450000',
  weekendRatePaise: '520000',
  extraAdultPaise: '150000',
  childWithBedPaise: '100000',
  childWithoutBedPaise: null,
  note: null,
  ...over,
});

export const LINES: RateLineView[] = [
  line(1, {}),
  line(2, { mealPlan: 'MAP', ratePaise: '560000', weekendRatePaise: '640000' }),
  line(3, { roomTypeId: ROOM_TYPES[1]!.roomTypeId, roomTypeName: ROOM_TYPES[1]!.name, ratePaise: '820000', weekendRatePaise: null, note: 'Includes evening boat ride for two.' }),
  line(4, { seasonFrom: '2027-04-01', seasonTo: '2027-09-30', ratePaise: '380000', weekendRatePaise: '420000' }),
];

const row = (n: number, over: Partial<RateContractRow>): RateContractRow => ({
  contractId: id(n),
  contractNo: `RC-2026-00004${n}`,
  versionNo: 2,
  supplierName: 'Synthetic Lakeside Stays Pvt Ltd',
  hotelName: 'Synthetic Lake Palace Udaipur',
  city: 'Udaipur',
  validFrom: '2026-12-01',
  validTo: '2027-09-30',
  daysLeft: 321,
  status: 'active',
  lineCount: 4,
  enteredByName: 'Synthetic Purchase Jodhpur',
  rowVersion: 3,
  ...over,
});

export const ROWS: RateContractRow[] = [
  row(1, { status: 'pending_approval', daysLeft: 321 }),
  row(2, { hotelName: 'Synthetic Desert Camp Jaisalmer', city: 'Jaisalmer', supplierName: 'Synthetic Thar Trails', validFrom: '2026-10-01', validTo: '2026-12-10', daysLeft: 27, lineCount: 6, versionNo: 1 }),
  row(3, { hotelName: 'Synthetic Fort View Jodhpur', city: 'Jodhpur', supplierName: 'Synthetic Blue City Hotels', status: 'draft', lineCount: 0, versionNo: 1, enteredByName: 'Synthetic Purchase Delhi' }),
  row(4, { hotelName: 'Synthetic Hill Resort Mount Abu', city: 'Mount Abu', supplierName: 'Synthetic Aravalli Holidays', status: 'returned', lineCount: 3, versionNo: 1 }),
  row(5, { hotelName: 'Synthetic Lake Palace Udaipur', versionNo: 1, validFrom: '2026-04-01', validTo: '2026-11-30', daysLeft: -1, status: 'ended', lineCount: 5 }),
  row(6, { hotelName: 'Synthetic Haveli Bikaner with a long name for the narrow screen check', city: 'Bikaner', supplierName: 'Synthetic Heritage Rooms and Travel Services', validFrom: '2026-11-01', validTo: '2026-11-20', daysLeft: 7, versionNo: 3 }),
];

export const DETAIL: RateContractDetail = {
  ...ROWS[0]!,
  supplierId: id(40),
  hotelId: id(41),
  source: 'manual',
  cancellationTerms: 'Free cancellation up to 15 days before arrival.\nOne night charged from 14 to 7 days.\nFull stay charged within 7 days.',
  note: 'Rates agreed on a call on 10 Nov 2026.',
  returnReason: null,
  endReason: null,
  decidedByName: null,
  decidedAt: null,
  lines: LINES,
  blackouts: [
    { fromDate: '2026-12-24', toDate: '2027-01-01' },
    { fromDate: '2027-03-13', toDate: '2027-03-14' },
  ],
  files: [{ fileId: id(50), fileName: 'synthetic-lake-palace-rates-2026-27.pdf', status: 'stored', uploadedAt: '2026-11-10T06:30:00Z', uploadedByName: 'Synthetic Purchase Jodhpur' }],
  history: [
    { contractId: id(5), contractNo: 'RC-2026-000045', versionNo: 1, validFrom: '2026-04-01', validTo: '2026-11-30', status: 'ended', decidedByName: 'Synthetic Manager Jodhpur', decidedAt: '2026-03-28T10:00:00Z', endReason: 'Replaced by RC-2026-000041' },
  ],
  can: { edit: false, submit: false, approve: true, return: true, end: false },
};

export const DRAFT: RateContractDetail = {
  ...DETAIL,
  ...ROWS[2]!,
  supplierId: id(42),
  hotelId: id(43),
  status: 'draft',
  lines: [],
  blackouts: [],
  files: [],
  history: [],
  cancellationTerms: null,
  note: null,
  can: { edit: true, submit: true, approve: false, return: false, end: false },
};

export const DRAFT_WITH_LINES: RateContractDetail = { ...DETAIL, status: 'draft', can: { edit: true, submit: true, approve: false, return: false, end: false } };

export const RETURNED: RateContractDetail = {
  ...DETAIL,
  status: 'returned',
  returnReason: 'The weekend rate for the suite is missing, and the March blackout dates do not match the supplier’s sheet.',
  decidedByName: 'Synthetic Manager Jodhpur',
  decidedAt: '2026-11-12T09:00:00Z',
  can: { edit: true, submit: true, approve: false, return: false, end: false },
};

export const ACTIVE: RateContractDetail = { ...DETAIL, status: 'active', decidedByName: 'Synthetic Manager Delhi', decidedAt: '2026-11-11T08:00:00Z', can: { edit: false, submit: false, approve: false, return: false, end: true } };

export const ENDED: RateContractDetail = { ...DETAIL, ...ROWS[4]!, supplierId: DETAIL.supplierId, hotelId: DETAIL.hotelId, status: 'ended', endReason: 'Replaced by RC-2026-000041', history: [], can: { edit: false, submit: false, approve: false, return: false, end: false } };

export const SUPPLIERS: ContractSupplierChoice[] = [
  {
    supplierId: id(40),
    supplierName: 'Synthetic Lakeside Stays Pvt Ltd',
    hotels: [
      { hotelId: id(41), name: 'Synthetic Lake Palace Udaipur', city: 'Udaipur' },
      { hotelId: id(44), name: 'Synthetic Garden Retreat Udaipur', city: 'Udaipur' },
    ],
  },
  { supplierId: id(42), supplierName: 'Synthetic Blue City Hotels', hotels: [{ hotelId: id(43), name: 'Synthetic Fort View Jodhpur', city: 'Jodhpur' }] },
  { supplierId: id(45), supplierName: 'Synthetic New Channel (no hotels yet)', hotels: [] },
];

const nights = (from: string, n: number, rate: string, weekendRate: string, lineId: string) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const wd = d.getUTCDay();
    const weekend = wd === 5 || wd === 6;
    return { date: d.toISOString().slice(0, 10), ratePaise: weekend ? weekendRate : rate, lineId, weekend };
  });

/** 29 Mar to 3 Apr 2027: three nights in the winter season, two in summer (one weekend night). */
export const LOOKUP_OK: RateContractLookup = (() => {
  const n = [...nights('2027-03-29', 3, '450000', '520000', LINES[0]!.lineId), ...nights('2027-04-01', 2, '380000', '420000', LINES[3]!.lineId)];
  const per = n.reduce((s, x) => s + BigInt(x.ratePaise), 0n);
  return {
    state: 'ok',
    contractIds: [DETAIL.contractId],
    nights: n,
    perRoomTotalPaise: per.toString(),
    totalPaise: (per * 2n).toString(),
    endedOn: null,
    roomTypes: ROOM_TYPES.map(({ roomTypeId, name }) => ({ roomTypeId, name })),
  };
})();

export const LOOKUP_NONE: RateContractLookup = { ...LOOKUP_OK, state: 'no_contract', contractIds: [], nights: [], perRoomTotalPaise: null, totalPaise: null };
export const LOOKUP_ENDED: RateContractLookup = { ...LOOKUP_NONE, state: 'ended', endedOn: '2027-03-15' };
export const LOOKUP_PARTIAL: RateContractLookup = { ...LOOKUP_OK, state: 'partial', nights: LOOKUP_OK.nights.slice(0, 3), totalPaise: null, perRoomTotalPaise: null };
export const LOOKUP_BLACKOUT: RateContractLookup = { ...LOOKUP_NONE, state: 'blackout' };

export const STAY = { checkIn: '2027-03-29', checkOut: '2027-04-03', rooms: 2 };

export const SHEET: RateSheetImportSummary = {
  contracts: 2,
  lines: 9,
  newRoomTypes: 1,
  invalidRows: 2,
  warnings: { newRoomType: 1, overlapsActiveContract: 3 },
  rows: [
    { rowNo: 2, outcome: 'create', reasons: [], warnings: ['overlaps_active_contract'], values: { supplierRef: 'SUP-SYN-0040', hotelRef: 'Synthetic Lake Palace Udaipur', validFrom: '2027-04-01', validTo: '2028-03-31', seasonFrom: '2027-04-01', seasonTo: '2027-09-30', roomType: 'Deluxe room', mealPlan: 'CP', rate: '3900', weekendRate: '4300', blackoutDates: null } },
    { rowNo: 3, outcome: 'create', reasons: [], warnings: ['new_room_type'], values: { supplierRef: 'SUP-SYN-0040', hotelRef: 'Synthetic Lake Palace Udaipur', validFrom: '2027-04-01', validTo: '2028-03-31', seasonFrom: '2027-04-01', seasonTo: '2027-09-30', roomType: 'Premier lake room', mealPlan: 'MAP', rate: '6100', weekendRate: null, blackoutDates: '2027-12-24..2028-01-01' } },
    { rowNo: 4, outcome: 'invalid', reasons: ['season_outside_validity'], warnings: [], values: { supplierRef: 'SUP-SYN-0040', hotelRef: 'Synthetic Lake Palace Udaipur', validFrom: '2027-04-01', validTo: '2028-03-31', seasonFrom: '2028-03-01', seasonTo: '2028-04-15', roomType: 'Deluxe room', mealPlan: 'CP', rate: '4100', weekendRate: null, blackoutDates: null } },
    { rowNo: 5, outcome: 'invalid', reasons: ['supplier_does_not_sell_hotel', 'meal_plan_invalid'], warnings: [], values: { supplierRef: 'Synthetic Thar Trails', hotelRef: 'Synthetic Fort View Jodhpur', validFrom: '2027-04-01', validTo: '2027-09-30', seasonFrom: '2027-04-01', seasonTo: '2027-09-30', roomType: 'Standard', mealPlan: 'Half board', rate: '2500', weekendRate: null, blackoutDates: null } },
  ],
  moreRows: 7,
};
