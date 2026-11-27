import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state of Manager · Approvals (redesign R3, design plan 1.5): shaped
 * like the page that streams in — the title, the row of summary chips, and
 * two sections of approval cards with their decision buttons at the bottom.
 * Announced once, politely; the shapes are hidden from screen readers and
 * the pulse stops when the person prefers reduced motion.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading approvals…
      </p>
      <div aria-busy="true" className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-7 w-48 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-44 rounded-full" />
          <Skeleton className="h-9 w-40 rounded-full" />
          <Skeleton className="h-9 w-36 rounded-full max-sm:hidden" />
        </div>
        {[0, 1].map((section) => (
          <div key={section} className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-4 w-full max-w-md" />
            {[0, 1].map((row) => (
              <div key={row} className="flex flex-col gap-2.5 rounded-card border border-line px-4.5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-5 w-64 max-w-full" />
                  </div>
                  <Skeleton className="h-6 w-24 max-sm:hidden" />
                </div>
                <Skeleton className="h-4 w-full max-w-sm" />
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-32 rounded-control" />
                  <Skeleton className="h-8 w-36 rounded-control" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
