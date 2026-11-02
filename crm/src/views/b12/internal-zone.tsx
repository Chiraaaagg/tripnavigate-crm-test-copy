import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/*
 * money-privacy C1 / copy DA-190: the internal zone of a quotation price
 * area. Its own heading with a lock icon and words (never a tint alone),
 * apart from the figures the customer sees. Server-safe (no hooks), used by
 * the editor's option totals and the read-only summary after sharing.
 */
export const INTERNAL_ZONE_TITLE = 'Internal — never printed, not on the customer copy';

export function InternalZone({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-labelledby={id} className={cn('flex flex-col gap-1.5 rounded-control border border-dashed border-line-strong bg-card px-3 py-2.5', className)}>
      <p id={id} className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Lock aria-hidden="true" className="size-3.5 text-quiet" />
        {INTERNAL_ZONE_TITLE}
      </p>
      {children}
    </div>
  );
}
