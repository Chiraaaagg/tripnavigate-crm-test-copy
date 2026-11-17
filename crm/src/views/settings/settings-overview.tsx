import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Status, type StatusKind } from '@/components/ui/status';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OverviewRowVM, OverviewTone, SettingsTabVM } from '@/modules/settings/contracts';
import { AreaIcon, LastAreaLink } from './settings-tabs';

/*
 * Settings · Overview (R1, audit N7; design plan 1.4): the landing page of
 * the Settings menu item. One row per area this person may open: the area
 * (a link), its state in words with an icon (never colour alone) and one
 * line of what is true now. Each row comes from a read that already exists
 * and fails on its own to "Not known" (never Off, never 0). The last area
 * this browser opened is offered as "Back to …". Read only: no control here.
 */

const TONE_KIND: Record<Exclude<OverviewTone, 'none'>, StatusKind> = {
  ok: 'confirmed',
  attention: 'needs_attention',
  info: 'recorded',
  off: 'off',
  unknown: 'not_known',
};

export function SettingsOverviewView({ rows, tabs }: { rows: OverviewRowVM[]; tabs: SettingsTabVM[] }) {
  return (
    <>
      <LastAreaLink tabs={tabs} />
      <Card>
        <CardHeader>
          <CardTitle id="overview-areas-heading">Every area</CardTitle>
          <CardDescription>Open an area to see or change its settings.</CardDescription>
        </CardHeader>
        <Table label="Settings areas and their state" stackOnMobile wrapperClassName="rounded-b-card">
          <TableCaption className="sr-only">Settings areas and their state</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Area</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.category} data-area={row.category}>
                <TableCell className="whitespace-nowrap max-sm:whitespace-normal">
                  <Link href={row.href} className={cn('inline-flex items-center gap-2 rounded-chip font-semibold text-brand-strong underline-offset-4 hover:underline', focusRing)}>
                    <AreaIcon category={row.category} className="text-quiet" />
                    {row.label}
                  </Link>
                </TableCell>
                <TableCell label="State">
                  {row.state.tone === 'none' ? (
                    <span className="text-quiet">
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">No summary for this area</span>
                    </span>
                  ) : (
                    <Status kind={TONE_KIND[row.state.tone]} label={row.state.label} />
                  )}
                </TableCell>
                <TableCell label="Now" className="text-copy max-sm:text-left">
                  {row.text}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

/** Someone without any Settings right opened /app/admin (the page's own check). One heading (the frame) and the reason. */
export function SettingsOverviewNoPermissionView() {
  return (
    <Notice tone="restricted" role="status">
      <p>Only staff with a Settings right can open Settings.</p>
    </Notice>
  );
}
