import { describe, expect, it } from 'vitest';
import type { PushDeviceRow, PushDeviceState } from '@/views/notices/device-alerts-types';
import { deviceDate, deviceStateLine, deviceStateWord, MAX_PUSH_DEVICES, turnOnBlockedReason } from '@/views/notices/device-alerts-words';

const row = (i: number, thisDevice = false): PushDeviceRow => ({ deviceId: `d${String(i)}`, label: `Chrome ${String(i)}`, createdAt: '2026-11-01T00:00:00Z', lastUsedAt: null, thisDevice });
const STATES: PushDeviceState[] = ['unsupported', 'needs_home_screen', 'blocked', 'off', 'on'];

describe('alerts on this device words (contract 15.8)', () => {
  it('says every state in words', () => {
    for (const s of STATES) expect(deviceStateLine(s).length).toBeGreaterThan(10);
    expect(deviceStateLine('needs_home_screen')).toMatch(/Home Screen/);
    expect(deviceStateLine('blocked')).toMatch(/Blocked by this browser/);
    expect(deviceStateLine('unsupported')).toMatch(/Not supported/);
  });

  it('heading word follows the switch first', () => {
    expect(deviceStateWord('on', false)).toBe('not switched on');
    expect(deviceStateWord('on', true)).toBe('on');
    expect(deviceStateWord('blocked', true)).toBe('blocked');
  });

  it('turn on is blocked with one reason', () => {
    expect(turnOnBlockedReason('off', false, [])).toBe('Alerts on devices are not switched on yet.');
    expect(turnOnBlockedReason('unsupported', true, [])).toMatch(/does not support/);
    expect(turnOnBlockedReason('needs_home_screen', true, [])).toMatch(/Home Screen/);
    expect(turnOnBlockedReason('blocked', true, [])).toMatch(/browser settings/);
    expect(turnOnBlockedReason('off', true, [])).toBeNull();
  });

  it('ten devices block a new one, not this device again', () => {
    const ten = Array.from({ length: MAX_PUSH_DEVICES }, (_, i) => row(i));
    expect(turnOnBlockedReason('off', true, ten)).toBe('You already have 10 devices. Remove one first.');
    expect(turnOnBlockedReason('off', true, [...ten.slice(1), row(99, true)])).toBeNull();
    expect(turnOnBlockedReason('off', true, ten.slice(1))).toBeNull();
  });

  it('dates in India time, missing as words', () => {
    expect(deviceDate(null)).toBe('not yet');
    expect(deviceDate('2026-11-12T20:00:00Z')).toMatch(/13 Nov 2026/);
    expect(deviceDate('bad')).toBe('bad');
  });
});

describe('device summary', () => {
  it('says when no alert went yet', async () => {
    const { deviceSummary } = await import('@/views/notices/device-alerts-words');
    expect(deviceSummary({ deviceId: 'd', label: 'x', createdAt: '2026-11-03T05:30:00Z', lastUsedAt: null, thisDevice: false })).toBe('Added 3 Nov 2026 · no alert yet');
  });
});

describe('finding 5: subscribed but not listed counts as off; test button reason', () => {
  it('effective state and test reason', async () => {
    const { effectiveDeviceState, testBlockedReason } = await import('@/views/notices/device-alerts-words');
    const mine = { deviceId: 'd1', label: 'Chrome', createdAt: '2026-11-03T05:30:00Z', lastUsedAt: null, thisDevice: true };
    const other = { ...mine, deviceId: 'd2', thisDevice: false };
    expect(effectiveDeviceState('on', [other])).toBe('off');
    expect(effectiveDeviceState('on', [mine, other])).toBe('on');
    expect(effectiveDeviceState('on', null)).toBe('on');
    expect(effectiveDeviceState('blocked', [])).toBe('blocked');
    expect(testBlockedReason(null, false)).toMatch(/Wait/);
    expect(testBlockedReason([], true)).toMatch(/did not load/);
    expect(testBlockedReason([other], false)).toMatch(/not in your list/);
    expect(testBlockedReason([mine], false)).toBeNull();
  });
});
