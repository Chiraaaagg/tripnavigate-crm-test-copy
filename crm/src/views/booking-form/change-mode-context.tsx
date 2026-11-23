'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ChangeModeView } from '@/views/booking-changes/types';

/*
 * Accounts phase 3 (contract 10.3 G6, screen 15.10): the booking form in
 * change mode. Present only while the open draft is the change version of an
 * approved change request; the service rows show "Changed" / "In the request"
 * / "Read-only: not in the request", and services outside a `change` request
 * open read only (the database also refuses them: change_outside_request).
 */

const ChangeModeContext = createContext<ChangeModeView | null>(null);

export function ChangeModeProvider({ value, children }: { value: ChangeModeView | null | undefined; children: ReactNode }) {
  return <ChangeModeContext.Provider value={value ?? null}>{children}</ChangeModeContext.Provider>;
}

export function useChangeMode(): ChangeModeView | null {
  return useContext(ChangeModeContext);
}

/** False for a service outside an approved `change` request (add / remove requests leave existing rows to the database rules). */
export function changeModeEditable(mode: ChangeModeView | null, itemId: string | null | undefined): boolean {
  if (!mode || mode.kind !== 'change' || !itemId) return true;
  return mode.requestItemIds.includes(itemId);
}
