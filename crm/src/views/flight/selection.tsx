'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/*
 * The flights ticked in the itinerary grids ("booked together on one
 * ticket"), shared with the Confirm tickets popup. Local to this page and
 * this viewer only.
 */

interface Selection {
  selected: string[];
  toggle: (sectorId: string, on: boolean) => void;
  clear: () => void;
  replace: (sectorIds: string[]) => void;
}

const Ctx = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = useCallback((id: string, on: boolean) => setSelected((s) => (on ? (s.includes(id) ? s : [...s, id]) : s.filter((x) => x !== id))), []);
  const clear = useCallback(() => setSelected([]), []);
  const replace = useCallback((ids: string[]) => setSelected([...ids]), []);
  const value = useMemo(() => ({ selected, toggle, clear, replace }), [selected, toggle, clear, replace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection(): Selection {
  return useContext(Ctx) ?? { selected: [], toggle: () => {}, clear: () => {}, replace: () => {} };
}
