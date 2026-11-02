'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

/**
 * Page error inside the staff frame (Direction A SH-05, copy G-13): what
 * happened, whether to check a save, and two ways on: try again (retry
 * re-fetches and re-renders this segment) or go to Home. The frame around it
 * keeps working.
 */
export default function StaffError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="flex max-w-xl flex-col gap-4 rounded-card border border-line bg-card p-6 font-sans text-base text-copy shadow-card">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-status-warning-tint text-status-warning">
          <TriangleAlert className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h1 className="m-0 text-xl leading-tight font-display tracking-heading text-ink">This page did not load</h1>
          <p className="m-0 mt-1.5 text-base text-copy">
            If you had just saved something, check it was saved before you try again. If it keeps happening, tell your admin.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cn(buttonVariants({ variant: 'primary' }))} onClick={() => retry()}>
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
        <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>
          Go to Home
        </Link>
      </div>
    </div>
  );
}
