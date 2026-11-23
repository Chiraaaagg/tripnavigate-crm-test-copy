import { FileCheck } from 'lucide-react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { formatIst } from '../deal-labels';
import { sizeText } from './format';
import type { ETicketFile } from './types';

/** Files tab: the e-tickets of the Deal's flights (private files; every open is recorded). */
export function FlightETicketsCard({ files, base }: { files: ETicketFile[]; base: string }) {
  return (
    <Card>
      <section aria-labelledby="flight-etickets-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="flight-etickets-heading">E-tickets</CardTitle>
            <CardDescription>Private files. Every open is recorded.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {files.length === 0 ? (
            <p className="m-0 text-quiet">No e-ticket attached yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {files.map((f) => (
                <li key={f.evidenceId} className="m-0 flex flex-wrap items-center gap-x-2 text-sm">
                  <FileCheck aria-hidden="true" className="size-4 shrink-0 text-faint" />
                  <a href={`${base}/${f.evidenceId}`} className={cn('rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4', focusRing)}>
                    {f.fileName}
                  </a>
                  <span className="text-quiet">
                    E-ticket · {sizeText(f.sizeBytes)} · {formatIst(f.storedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
