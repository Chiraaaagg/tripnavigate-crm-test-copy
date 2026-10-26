import { CircleCheck, CircleX, Info, Lock, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/*
 * Callout box for rules and situations the reader must know before acting
 * ("A claim is never money", "Private identity details", "Switched off").
 * Icon + text, never colour alone. role="note" by default; pass role="status"
 * for a polite live update or role="alert" for a refusal.
 */

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success' | 'restricted' | 'locked';

const TONE: Record<NoticeTone, { icon: LucideIcon; box: string; iconClass: string }> = {
  info: { icon: Info, box: 'border-status-info-line bg-status-info-tint', iconClass: 'text-status-info' },
  warning: { icon: TriangleAlert, box: 'border-status-warning-line bg-status-warning-tint', iconClass: 'text-status-warning' },
  danger: { icon: CircleX, box: 'border-status-danger-line bg-status-danger-tint', iconClass: 'text-status-danger' },
  success: { icon: CircleCheck, box: 'border-status-success-line bg-status-success-tint', iconClass: 'text-status-success' },
  restricted: { icon: ShieldAlert, box: 'border-brand-line bg-brand-tint', iconClass: 'text-brand-strong' },
  locked: { icon: Lock, box: 'border-line bg-wash', iconClass: 'text-quiet' },
};

export function Notice({
  tone = 'info',
  title,
  children,
  role = 'note',
  icon,
  className,
  id,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  role?: 'note' | 'status' | 'alert' | 'none';
  icon?: LucideIcon;
  className?: string;
  id?: string;
}) {
  const t = TONE[tone];
  const Icon = icon ?? t.icon;
  return (
    <div
      id={id}
      role={role === 'none' ? undefined : role}
      className={cn('flex gap-2.5 rounded-control border px-3.5 py-3 font-sans text-base text-copy', t.box, className)}
      data-slot="notice"
      data-tone={tone}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', t.iconClass)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="m-0 font-semibold text-ink">{title}</p> : null}
        {children ? <div className={cn('flex flex-col gap-1.5 [&_p]:m-0', title ? 'mt-0.75' : undefined)}>{children}</div> : null}
      </div>
    </div>
  );
}
