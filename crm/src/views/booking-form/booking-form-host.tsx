'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { BookingFormHostProps, BookingFormLoad } from '@/modules/fulfilment/contracts';
import { BookNowUnavailableView } from '../b11/book-views';
import { BookingFormScreen } from './booking-form-screen';
import type { BookingFormScreenProps } from './types';

/*
 * Booking reliability B1-3 (build contract section 3.2): the booking form
 * layout always renders this host, with the load it got on this render. The
 * host keeps the last good load in page memory only. When a re-read after a
 * save fails, the form stays mounted on that last good load (typed values,
 * open drawers and the save queue survive) and shows "Could not refresh this
 * page. Your entries are still here." with "Refresh again". Without a last
 * good load (the first load failed) it shows the "Booking did not load" page,
 * as before. Every save is still version-checked by the database, so a view
 * kept a little longer can never overwrite a newer one.
 */

type ScreenLoad = BookingFormLoad<BookingFormScreenProps>;
type OkLoad = Extract<ScreenLoad, { status: 'ok' }>;

/** The screen's props from an `ok` load (everything but the status). */
function screenProps(load: OkLoad): BookingFormScreenProps {
  const props: Partial<OkLoad> = { ...load };
  delete props.status;
  return props as BookingFormScreenProps;
}

export function BookingFormHost({ load }: BookingFormHostProps<BookingFormScreenProps>) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const [lastGood, setLastGood] = useState<OkLoad | null>(load.status === 'ok' ? load : null);
  if (load.status === 'ok' && load !== lastGood) setLastGood(load);
  const [refreshing, startRefresh] = useTransition();
  const shown: OkLoad | null = load.status === 'ok' ? load : lastGood;
  if (!shown) return <BookNowUnavailableView dealHref={params.id ? `/app/deals/${params.id}` : '/app/deals'} />;
  const props = screenProps(shown);
  return (
    <BookingFormScreen
      {...props}
      refreshFailed={load.status === 'refresh_failed'}
      refreshing={refreshing}
      onRefreshAgain={() => startRefresh(() => router.refresh())}
    />
  );
}
