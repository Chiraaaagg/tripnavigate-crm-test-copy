'use client';

import StaffError from '@/app/app/error';

/** Design preview only: the staff frame's page error with a "Try again" that has nothing to retry. */
export function PreviewStaffError() {
  return <StaffError error={new Error('Synthetic preview error')} retry={() => {}} />;
}
