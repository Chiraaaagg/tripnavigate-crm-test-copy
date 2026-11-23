/**
 * The approved company identity printed on customer documents (DEC-50).
 *
 * Approved by the owner in the build session on 13 October 2026 (DEC-50),
 * answering DEC-46 ("Accounts provides one approved set: legal name,
 * registered address, PAN, GSTIN per branch"). It is a reviewed code record,
 * not a database row: it changes only through a reviewed commit, never at
 * runtime and never from a form. Pure; no I/O.
 *
 * GSTIN: Accounts phase 2 (owner answer Q2, lead decision LD1, 11 November
 * 2026): the company uses ONE GSTIN for all branches, the Jodhpur
 * registration (Rajasthan, state code 08). Every known branch (Jodhpur,
 * Delhi, Ahmedabad) prints it on every customer document: quotations,
 * itineraries, Advance Invoices, Invoices and Credit Notes. A missing or
 * unknown branch still prints the "[GSTIN for branch]" placeholder, which
 * blocks the final document. The SQL mirror authz.cdoc_company
 * (20261204000200) prints the same values; a unit test keeps them equal.
 * Branch codes are the live `public.branches.code` values; the documents get
 * them from the read answers (`subject.branchCode` of quotation_get and
 * itinerary_document_get, `branchCode` of itinerary_render_input).
 */

import type { DocumentIdentity } from './contracts';
import { placeholder, type PlaceholderCollector } from './text';

export type LegalEntityCode = 'HOLIDAY_CHACHA';
export type BranchCode = 'JDH' | 'DEL' | 'AMD';

export interface CompanyIdentityRecord {
  legalName: string;
  registeredAddress: string;
  pan: string;
  /** The one company GSTIN (Q2 / LD1). */
  companyGstin: string;
  /** GST state of the company GSTIN. */
  companyGstinState: string;
  /** Per branch: the company GSTIN for every known branch (kept for existing readers). Null = not given (placeholder). */
  gstinByBranch: Readonly<Record<BranchCode, string | null>>;
}

const HOLIDAY_CHACHA_GSTIN = '08AAFCH9191M1ZV';

/** Branch display names and GST states (live `public.branches` name and state_name). */
export const BRANCHES: Readonly<Record<BranchCode, Readonly<{ name: string; state: string }>>> = Object.freeze({
  JDH: Object.freeze({ name: 'Jodhpur', state: 'Rajasthan' }),
  DEL: Object.freeze({ name: 'Delhi', state: 'Delhi' }),
  AMD: Object.freeze({ name: 'Ahmedabad', state: 'Gujarat' }),
});

export const COMPANY_IDENTITY: Readonly<Record<LegalEntityCode, Readonly<CompanyIdentityRecord>>> = Object.freeze({
  HOLIDAY_CHACHA: Object.freeze({
    legalName: 'Holiday Chacha Pvt Ltd',
    registeredAddress: '59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003',
    pan: 'AAFCH9191M',
    companyGstin: HOLIDAY_CHACHA_GSTIN,
    companyGstinState: 'Rajasthan',
    gstinByBranch: Object.freeze({
      JDH: HOLIDAY_CHACHA_GSTIN,
      DEL: HOLIDAY_CHACHA_GSTIN,
      AMD: HOLIDAY_CHACHA_GSTIN,
    }),
  }),
});

/** The statutory line of one customer document. `gstin` is the number or a "[GSTIN for …]" placeholder. */
export interface CompanyIdentityLine {
  legalName: string;
  registeredAddress: string;
  pan: string;
  gstin: string;
  /** GST state of the printed GSTIN (the company GSTIN's state); null when the branch is missing or unknown. */
  gstinState: string | null;
  /** Placeholder labels (without brackets), in print order; empty when the line is complete. */
  placeholders: string[];
}

function isBranchCode(value: string): value is BranchCode {
  return Object.prototype.hasOwnProperty.call(BRANCHES, value);
}

/** The word the placeholder uses when the branch is missing or unknown ("[GSTIN for branch]"). */
const UNKNOWN_BRANCH_WORD = 'branch';

function gstinLabel(branchWord: string): string {
  return `GSTIN for ${branchWord}`;
}

/**
 * The identity line for a document of the given branch: the company GSTIN
 * for every known branch (LD1). A branch without a GSTIN would give
 * "[GSTIN for <Branch>]"; a missing or unknown branch gives
 * "[GSTIN for branch]". Either placeholder blocks the final document.
 */
export function companyIdentityFor(branchCode: string | null | undefined, entity: LegalEntityCode = 'HOLIDAY_CHACHA'): CompanyIdentityLine {
  const record = COMPANY_IDENTITY[entity];
  const code = typeof branchCode === 'string' ? branchCode.trim().toUpperCase() : '';
  const known = isBranchCode(code) ? code : null;
  const branch = known ? BRANCHES[known] : null;
  const given = known ? record.gstinByBranch[known] : null;
  const label = gstinLabel(branch ? branch.name : UNKNOWN_BRANCH_WORD);
  return {
    legalName: record.legalName,
    registeredAddress: record.registeredAddress,
    pan: record.pan,
    gstin: given ?? placeholder(label),
    // Accounts phase 2 (LD1): the state of the printed (company) GSTIN.
    gstinState: given ? record.companyGstinState : null,
    placeholders: given ? [] : [label],
  };
}

/**
 * The document input's identity line; a GSTIN placeholder is recorded on the
 * adapter's collector (call it last: the footer prints last).
 */
export function documentIdentity(branchCode: string | null | undefined, ph: PlaceholderCollector): DocumentIdentity {
  const line = companyIdentityFor(branchCode);
  const [missing] = line.placeholders;
  return {
    legalName: line.legalName,
    registeredAddress: line.registeredAddress,
    pan: line.pan,
    gstin: missing ? ph.mark(missing) : line.gstin,
    gstinState: line.gstinState,
  };
}

// ---------------------------------------------------------------------------
// Staff-facing wording for a missing company GSTIN (review of DEC-50). The
// GSTIN is company data approved by Accounts, never a fact staff can fill in,
// so screens say so instead of the generic "fill in the missing facts".
// ---------------------------------------------------------------------------

export const COMPANY_GSTIN_TEXT = {
  notApproved: 'The company GSTIN for {branch} is not approved yet. Ask Accounts; there is nothing for you to fill in.',
  quotationTitle: 'Company GSTIN missing on this quotation',
  quotationWarning: "This quotation prints a '[GSTIN for {branch}]' mark instead of the company GSTIN, because Accounts has not approved it yet. Ask Accounts before sending it to the customer.",
  /** The document's branch is unknown: not an Accounts matter (a data problem for the CRM team). */
  unknownBranch: 'The branch of this document is not known, so the company GSTIN cannot be printed. Tell the CRM team.',
  /** Short notes for the made-documents list. */
  listNotApproved: 'company GSTIN not approved',
  listUnknownBranch: 'company GSTIN not printed (branch not known)',
} as const;

/** The branch word `companyGstinBranch` gives for the "[GSTIN for branch]" placeholder (branch missing or unknown). */
export const UNKNOWN_GSTIN_BRANCH = 'this branch';

/**
 * The branch a company GSTIN placeholder label stands for, in words
 * ("Delhi"; "this branch" for a missing or unknown branch), or null when the
 * label is any other placeholder. Matches only the labels this record makes.
 */
export function companyGstinBranch(label: string): string | null {
  for (const branch of Object.values(BRANCHES)) if (label === gstinLabel(branch.name)) return branch.name;
  return label === gstinLabel(UNKNOWN_BRANCH_WORD) ? UNKNOWN_GSTIN_BRANCH : null;
}

/** True when a placeholder label is the company GSTIN placeholder. */
export function isCompanyGstinPlaceholder(label: string): boolean {
  return companyGstinBranch(label) !== null;
}

/**
 * Splits placeholder labels into company GSTIN gaps (branch words, once each)
 * and the other missing facts (as given, in order).
 */
export function splitCompanyGstinPlaceholders(labels: readonly string[]): { gstinBranches: string[]; others: string[] } {
  const gstinBranches: string[] = [];
  const others: string[] = [];
  for (const label of labels) {
    const branch = companyGstinBranch(label);
    if (branch === null) others.push(label);
    else if (!gstinBranches.includes(branch)) gstinBranches.push(branch);
  }
  return { gstinBranches, others };
}

/** The branch (in words) whose company GSTIN is not approved yet, for a branch code; null when it is given. */
export function companyGstinGapFor(branchCode: string | null | undefined): string | null {
  const [label] = companyIdentityFor(branchCode).placeholders;
  return label ? companyGstinBranch(label) : null;
}

/** "The company GSTIN for Delhi is not approved yet. Ask Accounts; …" (unknown branch: "Tell the CRM team"). */
export function companyGstinMissingText(branch: string): string {
  if (branch === UNKNOWN_GSTIN_BRANCH) return COMPANY_GSTIN_TEXT.unknownBranch;
  return COMPANY_GSTIN_TEXT.notApproved.replace('{branch}', branch);
}

/** The quotation page and preview warning (the lead's decision: a warning, never a block on marking it sent). */
export function quotationGstinWarning(branch: string): string {
  if (branch === UNKNOWN_GSTIN_BRANCH) return COMPANY_GSTIN_TEXT.unknownBranch;
  return COMPANY_GSTIN_TEXT.quotationWarning.replace('{branch}', branch);
}

/** The short note for the made-documents list ("company GSTIN not approved"). */
export function companyGstinListNote(branch: string): string {
  return branch === UNKNOWN_GSTIN_BRANCH ? COMPANY_GSTIN_TEXT.listUnknownBranch : COMPANY_GSTIN_TEXT.listNotApproved;
}
