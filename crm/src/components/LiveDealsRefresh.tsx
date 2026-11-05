'use client';

import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type LiveMode, startLiveRefresh } from '@/modules/deals/live-refresh';
import { getRealtimeAccessToken } from '@/modules/deals/server/realtime';

/** A click on an internal link counts as a pending navigation for this long (it ends earlier when the page changes). */
const NAVIGATION_GRACE_MS = 10_000;

/** DA-46 (copy §16.4): the page indicator never claims that Bitrix data is fresh (that is the list's freshness line). */
const MODE_TEXT: Record<LiveMode, string> = {
  connecting: 'Connecting…',
  live: 'Live updates on',
  polling: 'Checking for updates every 30 seconds',
};

/**
 * Keeps a deal page current while it is open. Subscribes to changes on
 * public.deals and public.deal_assignments (optionally one deal) and the
 * public.deal_list_changes signal (removals/restores) through
 * Supabase Realtime, which applies
 * the viewer's RLS, and on any change calls router.refresh() (debounced), so
 * the server re-reads the data through the normal RLS queries. The Realtime
 * payload is ignored on purpose. Falls back to refreshing every 30 seconds.
 */
export function LiveDealsRefresh({
  supabaseUrl,
  supabasePublishableKey,
  dealId,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /** Deal detail page: only this deal's changes. */
  dealId?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<LiveMode>('connecting');
  // Time of the last internal link click / history move: a refresh while that
  // navigation loads would re-render THIS page and cancel it.
  const navigatingSince = useRef(0);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.origin !== window.location.origin) return;
      navigatingSince.current = Date.now();
    };
    const onHistory = () => {
      navigatingSince.current = Date.now();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onHistory);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onHistory);
    };
  }, []);

  useEffect(() => {
    const client = createClient(supabaseUrl, supabasePublishableKey, {
      // No browser Auth client: the token comes from the server on demand.
      accessToken: async () => (await getRealtimeAccessToken().catch(() => null)) ?? '',
    });
    const stop = startLiveRefresh({
      refresh: () => router.refresh(),
      isBusy: () => Date.now() - navigatingSince.current < NAVIGATION_GRACE_MS,
      onMode: setMode,
      subscribe: ({ onChange, onStatus }) => {
        const channel = client
          .channel(dealId ? `deal-${dealId}` : 'deals')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'deals', ...(dealId ? { filter: `id=eq.${dealId}` } : {}) },
            () => onChange(),
          )
          // Ownership changes (grant / revoke / Bitrix reassignment) move assignments.
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'deal_assignments', ...(dealId ? { filter: `deal_id=eq.${dealId}` } : {}) },
            () => onChange(),
          )
          // Removals (sync date / pipeline / stage settings): the removed row is no
          // longer visible to anyone, so it sends no event; this signal row does.
          .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_list_changes' }, () => onChange())
          .subscribe((status) => onStatus(status));
        return () => {
          void client.removeChannel(channel);
        };
      },
    });
    return () => {
      stop();
      void client.removeAllChannels();
    };
  }, [router, supabaseUrl, supabasePublishableKey, dealId]);

  return (
    <p className={`live-indicator ${mode}`} role="status" aria-live="polite">
      <span aria-hidden="true" className="status-glyph">
        {mode === 'live' ? '●' : '◷'}
      </span>
      {MODE_TEXT[mode]}
    </p>
  );
}
