import { describe, expect, it } from 'vitest';
import { recoveryCleanupState } from '@/modules/identity/contracts';

describe('recoveryCleanupState', () => {
  it('is done only with a recorded completion and no error', () => {
    expect(recoveryCleanupState({ cleanupCompletedAt: '2026-10-01T11:00:00Z', cleanupError: null })).toBe('done');
  });

  it('is failed whenever an error is recorded, even with an older completion time', () => {
    expect(recoveryCleanupState({ cleanupCompletedAt: null, cleanupError: 'provider_unavailable:503' })).toBe('failed');
    expect(recoveryCleanupState({ cleanupCompletedAt: '2026-10-01T11:00:00Z', cleanupError: 'unknown' })).toBe('failed');
  });

  it('is stuck when the database refused the cleanup plan, so only a new recovery can help', () => {
    expect(recoveryCleanupState({ cleanupCompletedAt: null, cleanupError: 'plan_lookup:22023' })).toBe('stuck');
    expect(recoveryCleanupState({ cleanupCompletedAt: null, cleanupError: 'plan_lookup:42501' })).toBe('failed');
  });

  it('treats missing or unrecorded fields as pending, never as done', () => {
    expect(recoveryCleanupState({ cleanupCompletedAt: null, cleanupError: null })).toBe('pending');
    expect(recoveryCleanupState({})).toBe('pending');
    expect(recoveryCleanupState({ cleanupCompletedAt: '2026-10-01T11:00:00Z' })).toBe('pending');
    expect(recoveryCleanupState({ cleanupCompletedAt: '', cleanupError: null })).toBe('pending');
  });
});
