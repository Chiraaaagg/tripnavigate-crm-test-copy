import { describe, expect, it, vi } from 'vitest';

/*
 * Echo review B-H2: the booking form lives in the route-group layout
 * (book/(form)/layout.tsx) so moving between steps and refreshing after a
 * save never remount it; the [step] page only validates the address and
 * renders nothing. Synthetic ids only.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to), notFound: () => { throw new Error('notFound'); } }));

const { default: BookStepPage } = await import('@/app/app/deals/[id]/book/(form)/[step]/page');
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const run = (step: string) => BookStepPage({ params: Promise.resolve({ id: DEAL, step }) });

describe('booking form step page', () => {
  it('a step address renders nothing (the layout holds the form)', async () => {
    for (const step of ['travellers', 'stay', 'finish']) expect(await run(step)).toBeNull();
  });
  it('old six-step addresses redirect to the new step and section', async () => {
    await expect(run('trip')).rejects.toThrow(`redirect:/app/deals/${DEAL}/book/travellers#customer`);
    await expect(run('payment')).rejects.toThrow(`redirect:/app/deals/${DEAL}/book/finish#payment`);
  });
  it('an unknown step goes to the overview (which opens the first step that needs input)', async () => {
    await expect(run('files')).rejects.toThrow(`redirect:/app/deals/${DEAL}/book`);
  });
});
