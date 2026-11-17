/**
 * Pure supplier rules (Accounts phase 2, Track A; contract 5.1 and 5.7).
 * Mirrors of the database checks, for the screens' early hints only — the
 * database decides every value (20261204000100/0110).
 */

import type { SupplierDuplicateReason } from './contracts';

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const STATE_CODE_RE = /^(0[1-9]|[12][0-9]|3[0-8]|97)$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[0-9]{6,18}$/;
export const SOURCE_REF_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
export const PHONE_RE = /^[0-9+() -]{6,40}$/;
export const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

/** Upper case without spaces (how the database stores a GSTIN or PAN). */
export function normaliseCode(value: string | null | undefined): string {
  return (value ?? '').replace(/\s/g, '').toUpperCase();
}

export const isGstin = (v: string | null | undefined): boolean => GSTIN_RE.test(normaliseCode(v));
export const isPan = (v: string | null | undefined): boolean => PAN_RE.test(normaliseCode(v));
export const isStateCode = (v: string | null | undefined): boolean => STATE_CODE_RE.test((v ?? '').trim());

/** The PAN inside a GSTIN (characters 3 to 12). */
export function panOfGstin(gstin: string): string {
  return normaliseCode(gstin).slice(2, 12);
}

/**
 * Consistency of GSTIN, PAN and state (suppliers checks of 5.1). Returns the
 * field to correct (database hint), or null. Empty values are not checked.
 */
export function gstPanStateProblem(input: { gstin?: string | null; pan?: string | null; stateCode?: string | null }): 'gstin' | 'pan' | 'stateCode' | null {
  const gstin = normaliseCode(input.gstin);
  const pan = normaliseCode(input.pan);
  const state = (input.stateCode ?? '').trim();
  if (gstin && !GSTIN_RE.test(gstin)) return 'gstin';
  if (pan && !PAN_RE.test(pan)) return 'pan';
  if (state && !STATE_CODE_RE.test(state)) return 'stateCode';
  if (gstin && pan && panOfGstin(gstin) !== pan) return 'pan';
  if (gstin && state && gstin.slice(0, 2) !== state) return 'stateCode';
  return null;
}

/** XXXXX1234X (the database's authz.acct_mask_pan); null for anything that is not 10 characters. */
export function maskPan(pan: string | null | undefined): string | null {
  if (!pan || pan.length !== 10) return null;
  return `XXXXX${pan.slice(5, 9)}X`;
}

const NAME_KEY_STOP_WORDS = /\b(hotel|hotels|resort|the|pvt|private|ltd|limited|llp|travels|tours|and)\b/g;

/**
 * Mirror of authz.supplier_name_key: lower case, every character outside
 * [a-z0-9 ] becomes a space, the listed words are dropped, spaces removed.
 */
export function supplierNameKey(name: string | null | undefined): string {
  const cleaned = ` ${(name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
  return cleaned.replace(NAME_KEY_STOP_WORDS, ' ').replace(/ /g, '');
}

/** LD24: equal keys, or one key a prefix of the other with the shorter at least 5 characters. City compared separately. */
export function similarNameKeys(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short);
}

/** The 5.7 "similar name" rule on two names and their cities. */
export function similarSupplier(a: { name: string; city: string | null }, b: { name: string; city: string | null }): boolean {
  const ca = (a.city ?? '').trim().toLowerCase();
  const cb = (b.city ?? '').trim().toLowerCase();
  return ca !== '' && ca === cb && similarNameKeys(supplierNameKey(a.name), supplierNameKey(b.name));
}

/** One warning line: "Looks like Hotel X (same GSTIN) — check before saving". */
export function duplicateWarningText(d: { name: string; reasons: readonly SupplierDuplicateReason[] }, words: Record<SupplierDuplicateReason, string>): string {
  return `Looks like ${d.name} (${d.reasons.map((r) => words[r]).join(', ')}) — check before saving.`;
}
