import { describe, expect, it } from 'vitest';
import { BOOK_RELIABILITY_TEXT, ERROR_TEXT, UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
import { autosaveMayArm, cardStateOf, refusalReason, type SendOutcome } from '@/views/booking-form/autosave-queue';
import { requestIdFor } from '@/views/b11/result';

/*
 * Booking reliability B1-4 (d, e), B1-5 and B1-8, screen side: what a card
 * reads after one save, when autosave is paused (nothing is sent again by the
 * program after an unknown, unsent or signed-out save) and the request id an
 * exact "Try again" posts.
 */

const unknown = { ok: false, code: 'unexpected', message: 'x' } as SendOutcome;
const offline = { ok: false, code: 'unexpected', message: 'x', offline: true } as SendOutcome;
const session = { ok: false, code: 'session', message: ERROR_TEXT.session } as SendOutcome;
const stale = { ok: false, code: 'version_changed', message: '' } as SendOutcome;

describe('how a card reads after a save', () => {
  it('a save that could not be sent: W6a, "Try again", autosave paused', () => {
    expect(cardStateOf(offline)).toEqual({ state: 'fix', reason: BOOK_RELIABILITY_TEXT.offlineNotSaved, retry: true, paused: true });
  });

  it('an unknown outcome: today’s words, autosave paused (no automatic re-send)', () => {
    expect(cardStateOf(unknown)).toEqual({ state: 'fix', reason: UNKNOWN_OUTCOME_TEXT, paused: true });
  });

  it('an ended session: the signed-out words, the sign-in link, "Try again", autosave paused', () => {
    expect(cardStateOf(session)).toEqual({ state: 'fix', reason: ERROR_TEXT.session, signIn: true, retry: true, paused: true });
  });

  it('a stale card says why and offers "Load the latest and keep my entries"', () => {
    expect(cardStateOf(stale)).toEqual({ state: 'fix', reason: ERROR_TEXT.version_changed, conflict: true });
    expect(refusalReason(stale)).toBe(ERROR_TEXT.version_changed);
  });

  it('a success reads "Saved"; a card-specific outcome wins', () => {
    expect(cardStateOf({ ok: true, data: undefined, message: '' } as SendOutcome)).toEqual({ state: 'saved', reason: null });
    const note = { state: 'saved' as const, reason: null, note: BOOK_RELIABILITY_TEXT.passengersFoundSaved };
    expect(cardStateOf({ ...unknown, card: note })).toBe(note);
  });
});

describe('autosave pause', () => {
  it('no timer is armed while a card is paused on the same values', () => {
    expect(autosaveMayArm({ enabled: true, dirty: true, pausedOn: '{"a":1}', values: '{"a":1}' })).toBe('paused');
  });

  it('the next edit re-arms autosave', () => {
    expect(autosaveMayArm({ enabled: true, dirty: true, pausedOn: '{"a":1}', values: '{"a":12}' })).toBe('arm');
  });

  it('nothing unsaved or not editable: nothing to arm', () => {
    expect(autosaveMayArm({ enabled: true, dirty: false, pausedOn: null, values: '{}' })).toBe('idle');
    expect(autosaveMayArm({ enabled: false, dirty: true, pausedOn: null, values: '{}' })).toBe('idle');
  });

  it('not paused and dirty: arm as before', () => {
    expect(autosaveMayArm({ enabled: true, dirty: true, pausedOn: null, values: '{}' })).toBe('arm');
  });
});

describe('request id on "Try again"', () => {
  let n = 0;
  const fresh = () => `id-${(n += 1)}`;

  it('an exact retry after an unknown outcome posts the same request id', () => {
    expect(requestIdFor({ id: 'id-a', key: '7|{"x":1}', unknown: true }, '7|{"x":1}', fresh)).toBe('id-a');
  });

  it('changed values, or an answer that reached the server, get a fresh id', () => {
    expect(requestIdFor({ id: 'id-a', key: '7|{"x":1}', unknown: true }, '7|{"x":2}', fresh)).not.toBe('id-a');
    expect(requestIdFor({ id: 'id-a', key: '7|{"x":1}', unknown: false }, '7|{"x":1}', fresh)).not.toBe('id-a');
    expect(requestIdFor(null, 'k', fresh)).toMatch(/^id-/);
  });
});
