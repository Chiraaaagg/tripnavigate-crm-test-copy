'use client';

import { useEffect } from 'react';

/**
 * The Accounts deal page opened without `?tab=` shows the tab of the next
 * action. Writing that tab into the address (no navigation, no new history
 * entry) keeps the person on the same tab when a save revalidates the page,
 * even if the next action has moved on. Next.js keeps its router in step
 * with history.replaceState.
 */
export function KeepTabInAddress({ tab }: { tab: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') === tab) return;
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [tab]);
  return null;
}
