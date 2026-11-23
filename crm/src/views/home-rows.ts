import type { LucideIcon } from 'lucide-react';
import { mayOpenAddress, type SectionsViewer } from '@/app/app/sections';
import { plural } from '@/lib/format';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import type { SupplierMoneyHomeCounts } from '@/modules/supplier-money/contracts';
import type { FlightHomeCounts } from './flight/types';
import type { VisaHomeCounts } from './visa/types';

/*
 * Home "What needs you" rows: the row shape, the words on each row's button
 * and the menu filter (UX redesign R2). Plain data and pure functions with no
 * React, Next.js or view imports, so the browser tests (tests/e2e/home.e2e.ts)
 * can load them in Node. home-view.tsx re-exports everything here.
 */

/** One "What needs you" row: what, how many, and one button to an existing address. */
export interface HomeRow {
  key: keyof MyWorkCounts | keyof SupplierMoneyHomeCounts | keyof FlightHomeCounts | FlightMoneyHomeKey | keyof VisaHomeCounts | 'purchaseBookingChanged';
  label: string;
  count: number;
  href: string;
  action: string;
  icon: LucideIcon;
}

/** Flight build: the flight payment keys Track B adds to supplier_money_home_counts (read defensively: absent = hidden). */
export type FlightMoneyHomeKey = 'flightPaymentsReturned' | 'flightPaymentsMissing' | 'flightFaresToApprove';

/**
 * UX redesign R2 (SL-1, design plan 2.2): what a row's button does and to how
 * many, so the button is named for the count ("Open 3 drafts", "Verify 2
 * receipts"). [verb, one, many]; many defaults to one + "s".
 */
const ROW_BUTTON: Partial<Record<HomeRow['key'], readonly [string, string, string?]>> = {
  draftsToContinue: ['Open', 'draft'],
  returnedToMe: ['Fix', 'booking'],
  missingDetails: ['Complete', 'draft'],
  intakeNeeded: ['Start', 'booking'],
  quotationDraftsToFinish: ['Finish', 'draft'],
  acceptedQuotesToLink: ['Link', 'quotation'],
  receiptsToVerify: ['Verify', 'receipt'],
  claimsToProcess: ['Check', 'payment'],
  expensesToReview: ['Review', 'cost'],
  visaTasksWaiting: ['Open', 'task'],
  purchaseTasksNotTaken: ['Open', 'task'],
  purchaseWaitingForGoAhead: ['Open', 'task'],
  purchaseCostsWaitingForManager: ['Open', 'task'],
  paymentRequestsReturned: ['Fix', 'request'],
  supplierInvoicesMissing: ['Open', 'task'],
  goAheadToApprove: ['Review', 'request'],
  supplierPaymentsToApprove: ['Approve', 'payment'],
  supplierPaymentsToRecord: ['Record', 'payment'],
  supplierPaymentsToVerify: ['Verify', 'payment'],
  supplierDocumentsToReview: ['Check', 'document'],
  fundingToApprove: ['Approve', 'request'],
  fundingToRecover: ['Open', 'request'],
  managerApprovals: ['Open', 'approval'],
  flightDealsNotTaken: ['Open', 'flight'],
  flightDealsMine: ['Open', 'flight'],
  flightBookingChanged: ['Review', 'change'],
  flightChangesDecided: ['See', 'decision'],
  flightTravellersNamed: ['See', 'traveller'],
  flightReadyToFinish: ['Finish', 'flight'],
  flightPaymentsReturned: ['Fix', 'payment'],
  flightPaymentsMissing: ['Pay', 'batch', 'batches'],
  salesFlightChangesToDecide: ['Decide', 'change'],
  salesTravellersToName: ['Name', 'traveller'],
  visaApplicantsWaitingResult: ['Open', 'traveller'],
  visaHandoverPending: ['Finish', 'handover'],
  visaFeesReturned: ['Fix', 'fee'],
  visaFeesWithoutReceipt: ['Open', 'fee'],
  visaTravellerChanged: ['Review', 'change'],
  salesVisaResultsToSee: ['See', 'result'],
  purchaseBookingChanged: ['Review', 'change'],
};

/** The combined "waiting" row: what it counts depends on the queue it opens. */
const WAITING_BUTTON: Record<string, readonly [string, string, string?]> = {
  '/app/deals': ['Open', 'draft'],
  '/app/purchase': ['Open', 'task'],
  '/app/flight': ['Open', 'task'],
  '/app/visa': ['Open', 'task'],
  '/app/accounts': ['Review', 'booking'],
};

/**
 * The words on a waiting row's button, named for the count. A row that opens
 * one record ("Open the deal", "Open the task", "Open the oldest") keeps its
 * words: the count may cover more than that one record. A row with no entry
 * says "Open 3 waiting".
 */
export function homeRowButtonText(row: Pick<HomeRow, 'key' | 'count' | 'href' | 'action' | 'label'>): string {
  if (row.action.startsWith('Open the ')) return row.action;
  const path = row.href.split(/[?#]/)[0]!;
  const words = row.key === 'waitingForMe' && row.label !== 'Waiting for you across your roles' ? WAITING_BUTTON[path] : ROW_BUTTON[row.key];
  if (!words) return `Open ${plural(row.count, 'waiting', 'waiting')}`;
  const [verb, one, many] = words;
  return `${verb} ${plural(row.count, one, many)}`;
}

/**
 * The rows this person sees: with `sections` (the frame's menu flags), only
 * rows whose address the menu lets them open (sections.ts mayOpenAddress), so
 * Home and the menu never disagree. Without it (older callers, the preview
 * gallery) every row shows, as before. Every page still decides access itself.
 */
export function homeRowsFor(rows: HomeRow[], sections?: SectionsViewer): HomeRow[] {
  return sections ? rows.filter((r) => mayOpenAddress(sections, r.href)) : rows;
}
