import { CircleAlert, FileCheck2, Lock, TriangleAlert } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import type { ReactNode } from 'react';
import type { DealIdProofsView, TaskIdProofsView } from '@/modules/fulfilment/contracts';
import { dateText } from './book-fields';

/*
 * "Traveller ID proofs" on a Purchase, Flight or Visa & Passport task and on
 * the Accounts deal screen (B1.2 freeze note §2.2, DEC-41): the stored
 * identity proofs of the travellers concerned, each with an audited download.
 * Server-safe, no data access: the route passes what the database allowed.
 * `null` (no rule for this viewer, not installed) renders nothing; a refused
 * session or a failed read says so honestly instead of "no proofs".
 * Never shows money, contacts or ID numbers.
 */

export type IdProofsState = TaskIdProofsView | DealIdProofsView | null | 'refused' | 'error';

export function TravellerIdProofsCard({ state, headingLevel = 2 }: { state: IdProofsState; headingLevel?: 2 | 3 }) {
  if (state === null) return null;
  const title = (
    <CardTitle level={headingLevel} id="id-proofs-heading">
      Traveller ID proofs
    </CardTitle>
  );
  if (state === 'refused' || state === 'error') {
    return (
      <Card>
        <section aria-labelledby="id-proofs-heading">
          <CardHeader>{title}</CardHeader>
          <CardBody>
            <Notice tone="warning">
              {state === 'refused' ? 'Your session could not show the ID proofs. Sign in again or reload the page to see them.' : 'The ID proofs could not be loaded just now. Reload the page to try again.'}
            </Notice>
          </CardBody>
        </section>
      </Card>
    );
  }
  return (
    <Card>
      <section aria-labelledby="id-proofs-heading">
        <CardHeader>
          {title}
          <CardDescription>
            <span className="inline-flex gap-1.5">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
              Private identity documents for this work. Every view is recorded. Do not copy or forward them.
            </span>
          </CardDescription>
        </CardHeader>
        <CardBody>
          {state.travellers.length === 0 ? (
            <p className="m-0 text-quiet">No travellers on this booking yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Travellers and their ID proofs">
              {state.travellers.map((t) => (
                <li key={t.seq} className="m-0 flex flex-col gap-2 rounded-control border border-line bg-canvas px-3.5 py-3">
                  <p className="m-0 font-semibold text-ink">
                    {t.fullName || `Traveller ${t.seq}`} <span className="font-normal text-quiet">· {t.type === 'adult' ? 'Adult' : t.type === 'child' ? 'Child' : 'Infant'}</span>
                  </p>
                  {t.idProofs.length === 0 ? (
                    <p className="m-0 flex gap-2 text-sm text-copy">
                      {t.type === 'adult' ? <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-danger" /> : <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />}
                      {t.type === 'adult' ? 'No ID proof attached yet. Ask the salesperson.' : 'No ID proof attached (optional for a child).'}
                    </p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {t.idProofs.map((f) => (
                        <li key={f.fileId} className="m-0 flex flex-wrap items-center gap-3">
                          <FileCheck2 aria-hidden="true" className="size-4 shrink-0 text-status-success" />
                          <span className="min-w-40 flex-1 wrap-anywhere text-copy">
                            {f.fileName} <span className="text-sm text-quiet">· {f.sizeLabel} · attached {dateText(f.storedAt)}</span>
                          </span>
                          <a className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'min-h-11')} href={f.downloadHref} rel="noopener">
                            Open<span className="sr-only"> ID proof of {t.fullName || `traveller ${t.seq}`}: {f.fileName}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

/** A task screen's work area with the ID proofs card first (route files carry no classes). */
export function WithTravellerIdProofs({ state, children }: { state: IdProofsState; children?: ReactNode }) {
  if (state === null && !children) return null;
  return (
    <div className="flex flex-col gap-5">
      <TravellerIdProofsCard state={state} />
      {children}
    </div>
  );
}

/** The Accounts deal screen's ID proofs card, spaced below the deal view. */
export function AccountsDealIdProofs({ state }: { state: IdProofsState }) {
  if (state === null) return null;
  return (
    <div className="mt-5">
      <TravellerIdProofsCard state={state} />
    </div>
  );
}
