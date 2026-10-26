import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** Grey placeholder block. Decorative: wrap a group of them in <LoadingRegion>. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('h-4 rounded-chip bg-line animate-ui-pulse motion-reduce:animate-none', className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

/**
 * Announces loading once (a polite status) and marks the placeholder area,
 * not the status itself, as busy (aria-busy on a live region would hold back
 * its announcement). The shapes are hidden from screen readers.
 */
export function LoadingRegion({
  label = 'Loading…',
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-busy="true" className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}
