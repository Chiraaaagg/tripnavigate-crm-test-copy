import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-line bg-card font-sans text-base text-copy shadow-card', className)}
      data-slot="card"
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-line px-4.5 py-3.5', className)}
      {...props}
    />
  );
}

/** Card heading; pick the level that fits the page outline (default h2). */
export function CardTitle({ className, level = 2, ...props }: HTMLAttributes<HTMLHeadingElement> & { level?: 2 | 3 | 4 }) {
  const Heading = `h${level}` as const;
  return <Heading className={cn('m-0 text-lg leading-6 font-semibold tracking-[-0.005em] text-ink', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('m-0 text-sm text-quiet', className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4.5 py-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line px-4.5 py-3 text-sm text-quiet', className)}
      {...props}
    />
  );
}
