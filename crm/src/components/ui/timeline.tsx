import { Circle, CircleCheck, CircleDot, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/*
 * Ordered events or steps on a rail (history of a task, a claim or a booking's
 * versions; the states of a visa application). Idea from 21st.dev timelines
 * (cubby-ui 28295, olewandowski1 28340); nothing copied. Each entry carries
 * its state in words, so the rail and icons are decoration only.
 */

export type TimelineState = 'done' | 'current' | 'upcoming';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  /** When and by whom, e.g. "11 Oct, 14:05 · Sample Sales". */
  meta?: ReactNode;
  detail?: ReactNode;
  state?: TimelineState;
  icon?: LucideIcon;
}

const STATE: Record<TimelineState, { icon: LucideIcon; className: string; text: string }> = {
  done: { icon: CircleCheck, className: 'text-status-success', text: 'Done' },
  current: { icon: CircleDot, className: 'text-brand-strong', text: 'Now' },
  upcoming: { icon: Circle, className: 'text-faint', text: 'Later' },
};

export function Timeline({ items, label, showState = false, className }: { items: TimelineItem[]; label: string; showState?: boolean; className?: string }) {
  return (
    <ol aria-label={label} className={cn('m-0 flex list-none flex-col p-0 font-sans', className)} data-slot="timeline">
      {items.map((item, index) => {
        const s = STATE[item.state ?? 'done'];
        const Icon = item.icon ?? s.icon;
        const last = index === items.length - 1;
        return (
          <li key={item.id} className="relative m-0 flex gap-3 pb-4 last:pb-0" aria-current={item.state === 'current' ? 'step' : undefined}>
            {!last ? <span aria-hidden="true" className="absolute top-6 bottom-0 left-2.25 w-px bg-line-strong" /> : null}
            <Icon aria-hidden="true" className={cn('relative mt-0.5 size-4.5 shrink-0 bg-card', s.className)} />
            <div className="min-w-0 flex-1">
              <p className={cn('m-0 text-base text-ink', item.state === 'current' && 'font-semibold')}>
                {showState ? <span className="sr-only">{s.text}: </span> : null}
                {item.title}
              </p>
              {item.meta ? <p className="m-0 text-sm text-quiet">{item.meta}</p> : null}
              {item.detail ? <div className="mt-0.75 text-sm text-copy">{item.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
