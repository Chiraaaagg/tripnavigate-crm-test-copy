import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BOOKING_FORM_STEP_LABEL } from '@/modules/fulfilment/booking-form-contract';
import { isBookStep, isLegacyBookStep, legacyStepHref } from '@/views/b11/book-fields';

export async function generateMetadata({ params }: { params: Promise<{ step: string }> }): Promise<Metadata> {
  const { step } = await params;
  return { title: isBookStep(step) ? `Book now · ${BOOKING_FORM_STEP_LABEL[step]}` : 'Book now' };
}

/**
 * One step address of the booking form. The form itself is loaded and
 * rendered by the layout of this route group (Echo review B-H2), so this
 * page renders nothing visible. The six B1.1 step addresses redirect to the
 * new step and section before any read (static mapping, reveals nothing);
 * any other unknown step goes to the overview, which opens the first step
 * that needs input.
 */
export default async function BookStepPage({ params }: { params: Promise<{ id: string; step: string }> }) {
  const { id, step } = await params;
  if (isLegacyBookStep(step)) redirect(legacyStepHref(id, step));
  if (!isBookStep(step)) redirect(`/app/deals/${id}/book`);
  return null;
}
