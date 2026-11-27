import { cva } from 'class-variance-authority';
import { CircleCheck, CircleHelp, CircleX, Clock, Info, Send, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

const badgeVariants = cva(
  'inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-2 font-sans text-sm leading-5 font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        success: 'border-status-success-line bg-status-success-tint text-status-success',
        warning: 'border-status-warning-line bg-status-warning-tint text-status-warning',
        danger: 'border-status-danger-line bg-status-danger-tint text-status-danger',
        info: 'border-status-info-line bg-status-info-tint text-status-info',
        neutral: 'border-status-neutral-line bg-status-neutral-tint text-status-neutral',
        brand: 'border-brand-line bg-brand-tint text-brand-strong',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

/** Default icon per tone; a status always shows an icon AND a word, never colour alone. */
export const STATUS_ICONS: Record<StatusTone, LucideIcon> = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  info: Info,
  neutral: Clock,
  brand: Send,
};

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone?: StatusTone;
  /** Overrides the tone's default icon (pass an imported lucide icon). */
  icon?: LucideIcon;
  /** The status word(s), required: e.g. "Waiting for customer". */
  children: ReactNode;
  /**
   * Let longer words wrap onto a second line instead of being cut with an
   * ellipsis (default: one line, truncated). Use for sentence-like statuses
   * that must stay readable on a 320 px screen.
   */
  wrap?: boolean;
}

/** Status pill: icon + word on a pale tint (text contrast 4.79:1 or better). */
export function StatusBadge({ tone = 'neutral', icon, wrap = false, className, children, ...props }: StatusBadgeProps) {
  const Icon = icon ?? STATUS_ICONS[tone] ?? CircleHelp;
  return (
    <span
      className={cn(badgeVariants({ tone }), wrap && 'items-start rounded-control whitespace-normal [&_svg]:mt-0.75', className)}
      data-slot="status-badge"
      data-tone={tone}
      {...props}
    >
      <Icon aria-hidden="true" />
      <span className={wrap ? 'min-w-0 wrap-anywhere' : 'truncate'}>{children}</span>
    </span>
  );
}

/** Small neutral count, e.g. next to a card title. Give it an aria-label when the number alone is unclear. */
export function CountBadge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('inline-flex min-w-6 items-center justify-center rounded-full bg-wash px-2 font-sans text-xs leading-5 font-medium text-quiet tabular-nums', className)}
      {...props}
    />
  );
}
