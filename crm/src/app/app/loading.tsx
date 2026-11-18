import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state of the staff frame's content area (Direction A SH-04): the
 * sidebar, Menu button and account panel stay usable while a page streams in.
 * The shapes follow the common page layout (title, a row of counts or
 * filters, a table). Announced once, politely; the placeholder area is marked
 * busy (not the status itself) and its shapes are hidden from screen readers.
 * The pulse stops when the person prefers reduced motion.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-full max-w-md" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-40 rounded-control" />
          <Skeleton className="h-9 w-28 rounded-control" />
          <Skeleton className="h-9 w-36 rounded-control max-sm:hidden" />
        </div>
        <div className="flex flex-col overflow-hidden rounded-card border border-line bg-card">
          <Skeleton className="h-10 rounded-none bg-wash" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-4 border-t border-line px-4.5 py-3.5">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16 max-sm:hidden" />
              <Skeleton className="h-8 w-28 rounded-control" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
