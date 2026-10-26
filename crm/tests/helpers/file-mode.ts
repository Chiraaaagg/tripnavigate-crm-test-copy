import { expect } from 'vitest';

/**
 * Asserts an owner-only (0600) file. Windows has no POSIX permission bits:
 * Node always reports 0o666 there and access is governed by ACLs, so the
 * mode is checked only on POSIX systems (CI runs on Linux).
 */
export function expectOwnerOnlyMode(mode: number): void {
  if (process.platform === 'win32') return;
  expect(mode & 0o777).toBe(0o600);
}
