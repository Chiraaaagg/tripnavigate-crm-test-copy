import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn, focusRing } from './cn';

/**
 * Data table. Light header row, hairline dividers, right-aligned numbers.
 * With `stackOnMobile`, rows become labelled cards under 640px: give every
 * cell a `label` (the column name); the first cell is the row title. The
 * header row is then visually hidden (sr-only), not removed, so screen
 * readers keep the column headers.
 * The wrapper scrolls horizontally otherwise; it is focusable and labelled so
 * keyboard users can scroll it.
 *
 * Every part carries its table role explicitly (table, rowgroup, row,
 * columnheader, cell): when the stacked layout sets display:block, browsers
 * drop the implicit table semantics, and screen readers would lose the rows.
 */
export function Table({
  className,
  wrapperClassName,
  stackOnMobile = false,
  label,
  ...props
}: HTMLAttributes<HTMLTableElement> & {
  stackOnMobile?: boolean;
  label: string;
  /** Extra classes for the scrolling wrapper, e.g. `rounded-card` inside a card. */
  wrapperClassName?: string;
}) {
  return (
    <div
      className={cn('group/table relative w-full overflow-x-auto', focusRing, wrapperClassName)}
      data-stack={stackOnMobile ? 'true' : undefined}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table
        role="table"
        className={cn(
          'w-full border-collapse bg-transparent font-sans text-base text-copy',
          'group-data-[stack=true]/table:max-sm:block',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead role="rowgroup" className={cn('group-data-[stack=true]/table:max-sm:sr-only', className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody role="rowgroup" className={cn('group-data-[stack=true]/table:max-sm:block', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      role="row"
      className={cn(
        'border-b border-line last:border-b-0 hover:bg-canvas',
        'group-data-[stack=true]/table:max-sm:block group-data-[stack=true]/table:max-sm:px-4 group-data-[stack=true]/table:max-sm:py-3',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, numeric, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      role="columnheader"
      className={cn(
        'border-b border-line bg-canvas px-4.5 py-2.5 text-left align-middle text-xs font-semibold tracking-[0.04em] text-quiet uppercase',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  numeric,
  label,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; label?: string }) {
  return (
    <td
      role="cell"
      data-label={label}
      className={cn(
        'border-0 bg-transparent px-4.5 py-3 text-left align-middle',
        numeric && 'text-right font-medium text-ink tabular-nums',
        // Stacked: "Label ........ value" lines; the first cell is the title.
        'group-data-[stack=true]/table:max-sm:flex group-data-[stack=true]/table:max-sm:justify-between group-data-[stack=true]/table:max-sm:gap-3 group-data-[stack=true]/table:max-sm:px-0 group-data-[stack=true]/table:max-sm:py-1 group-data-[stack=true]/table:max-sm:text-right',
        'group-data-[stack=true]/table:max-sm:before:text-left group-data-[stack=true]/table:max-sm:before:text-sm group-data-[stack=true]/table:max-sm:before:font-normal group-data-[stack=true]/table:max-sm:before:text-quiet group-data-[stack=true]/table:max-sm:before:content-[attr(data-label)]',
        'group-data-[stack=true]/table:max-sm:first:block group-data-[stack=true]/table:max-sm:first:pb-2 group-data-[stack=true]/table:max-sm:first:text-left group-data-[stack=true]/table:max-sm:first:before:content-none',
        className,
      )}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('px-4.5 py-2 text-left text-sm font-normal text-quiet caption-bottom', className)} {...props} />;
}
