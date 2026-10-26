import { BedDouble, BookUser, CarFront, CircleCheck, Clock, Compass, Hourglass, type LucideIcon, Plane, PlayCircle, Stamp } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { cn } from '@/components/ui/cn';
import { formatPaise } from '@/modules/deals/dto';
import {
  type DealProgress,
  FLIGHT_TASK_STATUS_LABEL,
  type FlightSegment,
  PURCHASE_TASK_STATUS_LABEL,
  VISA_TASK_STATUS_LABEL,
  SERVICE_DEPARTMENT_LABEL,
  SERVICE_NEXT_STEP_TEXT,
  SERVICE_TYPE_LABEL,
  type ServiceFacts,
  type ServiceItemView,
  type ServiceType,
  progressText,
} from '@/modules/fulfilment/contracts';

/*
 * B1 leaf module: words, icons and small pills for sold services. Shared by
 * the Deal page, the Deals list, the intake screen, the Purchase screens and
 * the Flight queue, so every screen names a service and its state the same
 * way. Imports nothing from other view modules (no cycles).
 * Patterns (21st.dev, ideas only, nothing copied): a label chip with an icon
 * for the service type (hero_ui Chip 13842), status pills with icon + word
 * (the foundation's StatusBadge). Record: ui-foundation-21st-log-2026-10-09.md.
 */

/** One icon per service type (decorative; the label is always written). */
export const SERVICE_TYPE_ICON: Record<ServiceType, LucideIcon> = {
  hotel: BedDouble,
  transfer: CarFront,
  activity: Compass,
  flight: Plane,
  visa: Stamp,
  passport: BookUser,
};

/** Brand chip naming the service type (a label, not a status). */
export function ServiceTypePill({ type, className }: { type: ServiceType; className?: string }) {
  const Icon = SERVICE_TYPE_ICON[type];
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand-line bg-brand-tint py-0.5 pr-2.5 pl-2 font-sans text-sm leading-5 font-semibold whitespace-nowrap text-brand-strong',
        className,
      )}
      data-slot="service-type-pill"
      data-type={type}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Service type: </span>
      <span className="truncate">{SERVICE_TYPE_LABEL[type]}</span>
    </span>
  );
}

/** "Hotel ×2 · Transfer or cab · Flight": the chips of a Deal, duplicates folded into a count. */
export function countServiceTypes(types: ServiceType[]): Array<{ type: ServiceType; count: number }> {
  const out: Array<{ type: ServiceType; count: number }> = [];
  for (const type of types) {
    const found = out.find((o) => o.type === type);
    if (found) found.count += 1;
    else out.push({ type, count: 1 });
  }
  return out;
}

export function ServiceTypeChips({ types, emptyText = 'No services yet' }: { types: ServiceType[]; emptyText?: string }) {
  if (types.length === 0) return <span className="text-sm text-quiet">{emptyText}</span>;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Services sold">
      {countServiceTypes(types).map(({ type, count }) => (
        <li key={type} className="m-0 inline-flex items-center gap-1">
          <ServiceTypePill type={type} />
          {count > 1 ? (
            <span className="text-sm text-quiet tabular-nums">
              <span className="sr-only">, </span>×{count}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The state word of one item (planned, or its task's status in the department's own words). */
export interface ServiceStateInfo {
  tone: StatusTone;
  icon: LucideIcon;
  label: string;
}

export function serviceStateInfo(item: Pick<ServiceItemView, 'state' | 'department' | 'task'>): ServiceStateInfo {
  if (item.state === 'cancelled') return { tone: 'neutral', icon: Clock, label: 'Cancelled' };
  if (item.state === 'planned' || !item.task) return { tone: 'neutral', icon: Hourglass, label: 'Planned · no task yet' };
  // DA-287: each department in its own words (Visa and passport: Waiting to be taken · In progress · Completed).
  if (item.department === 'visa') {
    switch (item.task.status) {
      case 'completed':
      case 'supplier_confirmed':
        return { tone: 'success', icon: CircleCheck, label: VISA_TASK_STATUS_LABEL.completed };
      case 'in_progress':
        return { tone: 'info', icon: PlayCircle, label: VISA_TASK_STATUS_LABEL.in_progress };
      default:
        return { tone: 'warning', icon: Clock, label: VISA_TASK_STATUS_LABEL.not_started };
    }
  }
  const labels = item.department === 'flight' ? FLIGHT_TASK_STATUS_LABEL : PURCHASE_TASK_STATUS_LABEL;
  switch (item.task.status) {
    case 'supplier_confirmed':
      return { tone: 'success', icon: CircleCheck, label: labels.supplier_confirmed };
    case 'in_progress':
      return { tone: 'info', icon: PlayCircle, label: labels.in_progress };
    default:
      return { tone: 'warning', icon: Clock, label: labels.not_started };
  }
}

export function ServiceStatePill({ item, wrap = false }: { item: Pick<ServiceItemView, 'state' | 'department' | 'task'>; wrap?: boolean }) {
  const info = serviceStateInfo(item);
  return (
    <StatusBadge tone={info.tone} icon={info.icon} wrap={wrap}>
      <span className="sr-only">Service status: </span>
      {info.label}
    </StatusBadge>
  );
}

/** Who holds the item now: the task's assignee, or the department while nobody has taken it. */
export function serviceOwnerText(item: Pick<ServiceItemView, 'department' | 'task' | 'state'>): string {
  const dept = SERVICE_DEPARTMENT_LABEL[item.department];
  if (!item.task || item.state === 'planned') return `${dept} (after confirmation)`;
  if (item.task.assignedToYou) return 'You';
  return item.task.assigneeName ?? `${dept} · not taken yet`;
}

/** Where "next step" leads: the task page once a task exists, otherwise the intake screen. */
export function serviceNextHref(item: Pick<ServiceItemView, 'department' | 'task'>, dealId: string): string {
  if (item.task) return item.department === 'flight' ? `/app/flight/${item.task.taskId}` : item.department === 'visa' ? `/app/visa/${item.task.taskId}` : `/app/purchase/${item.task.taskId}`;
  return `/app/deals/${dealId}/intake`;
}

export function serviceNextLinkText(item: Pick<ServiceItemView, 'task' | 'department'>): string {
  if (!item.task) return 'Open intake';
  return item.department === 'flight' ? 'Open Flight task' : item.department === 'visa' ? 'Open Visa & Passport task' : 'Open Purchase task';
}

export function serviceNextStepText(item: Pick<ServiceItemView, 'nextStep'>): string {
  return SERVICE_NEXT_STEP_TEXT[item.nextStep];
}

export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? iso : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(t);
}

function shortDate(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? iso : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(t);
}

export function formatBudget(paise: string | null | undefined): string {
  return paise ? formatPaise(paise) : 'Not set';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function segmentText(s: FlightSegment): string {
  return `${s.from} → ${s.to} · ${shortDate(s.date)}`;
}

/** One line that identifies the service (title helper for lists; never a selling value). */
export function factsSummary(facts: ServiceFacts): string {
  switch (facts.type) {
    case 'hotel': {
      const f = facts.facts;
      return [f.city, f.checkIn && f.checkOut ? `${shortDate(f.checkIn)} → ${shortDate(f.checkOut)}` : '', f.rooms ? plural(f.rooms, 'room', 'rooms') : '']
        .filter(Boolean)
        .join(' · ');
    }
    case 'transfer': {
      const f = facts.facts;
      return [f.date ? shortDate(f.date) : '', f.vehicleType, f.passengers ? plural(f.passengers, 'passenger', 'passengers') : ''].filter(Boolean).join(' · ');
    }
    case 'activity': {
      const f = facts.facts;
      return [f.city, f.date ? shortDate(f.date) : '', f.participants ? plural(f.participants, 'participant', 'participants') : ''].filter(Boolean).join(' · ');
    }
    case 'flight': {
      const f = facts.facts;
      return [f.segments.map(segmentText).join(', '), f.passengers ? plural(f.passengers, 'passenger', 'passengers') : ''].filter(Boolean).join(' · ');
    }
    case 'visa': {
      const f = facts.facts;
      return [f.country, f.purpose, f.travelDate ? shortDate(f.travelDate) : ''].filter(Boolean).join(' · ');
    }
    case 'passport': {
      const f = facts.facts;
      return [f.officeCity, f.neededBy ? `needed by ${shortDate(f.neededBy)}` : ''].filter(Boolean).join(' · ');
    }
  }
}

/** Label/value pairs of the facts, in reading order, for facts blocks on every screen. */
export function factsLines(facts: ServiceFacts): Array<[string, string]> {
  const or = (v: string | number | null | undefined, fallback = 'None') => (v === null || v === undefined || v === '' ? fallback : String(v));
  switch (facts.type) {
    case 'hotel': {
      const f = facts.facts;
      return [
        ['Hotel', or(f.hotelName, 'Not set')],
        ['City', or(f.city, 'Not set')],
        ['Check-in', formatIsoDate(f.checkIn)],
        ['Check-out', formatIsoDate(f.checkOut)],
        ['Rooms', or(f.rooms, 'Not set')],
        ['Room type', or(f.roomType)],
        ['Meal plan', or(f.mealPlan)],
        ['Adults', or(f.adults, 'Not set')],
        ['Children', or(f.children, '0')],
        ['Inclusions', or(f.inclusions)],
        ['Special requests', or(f.specialRequests)],
      ];
    }
    case 'transfer': {
      const f = facts.facts;
      return [
        ['Route', or(f.route, 'Not set')],
        ['Date', formatIsoDate(f.date)],
        ['Vehicle', or(f.vehicleType, 'Not set')],
        ['Passengers', or(f.passengers, 'Not set')],
        ['Pick-up time', or(f.pickupTime, 'Not set')],
        ['Notes', or(f.notes)],
      ];
    }
    case 'activity': {
      const f = facts.facts;
      return [
        ['Activity', or(f.name, 'Not set')],
        ['City', or(f.city, 'Not set')],
        ['Date', formatIsoDate(f.date)],
        ['Participants', or(f.participants, 'Not set')],
        ['Time', or(f.time, 'Not set')],
        ['Notes', or(f.notes)],
      ];
    }
    case 'flight': {
      const f = facts.facts;
      return [
        ['Segments', f.segments.length > 0 ? f.segments.map(segmentText).join('; ') : 'Not set'],
        ['Passengers', or(f.passengers, 'Not set')],
        ['Preferred time', or(f.preferredTime, 'Not set')],
        ['Cabin', or(f.cabin, 'Not set')],
        ['Notes', or(f.notes)],
      ];
    }
    case 'visa': {
      const f = facts.facts;
      return [
        ['Country', or(f.country, 'Not set')],
        ['Purpose', or(f.purpose, 'Not set')],
        ['Planned travel date', formatIsoDate(f.travelDate)],
        ['Apply by', f.applyBy ? formatIsoDate(f.applyBy) : 'Not set'],
        ['Government fee paid by', or(f.feePaidBy, 'Not set')],
        ['Notes', or(f.notes)],
      ];
    }
    case 'passport': {
      const f = facts.facts;
      return [
        ['Application type', or(f.applicationType, 'Not set')],
        ['Passport office city', or(f.officeCity, 'Not set')],
        ['Needed by', f.neededBy ? formatIsoDate(f.neededBy) : 'Not set'],
        ['Notes', or(f.notes)],
      ];
    }
  }
}

/** Facts as a definition list (Lagoon look). Pass `legacy` to use the older `.facts` stylesheet on Purchase screens. */
export function FactsBlock({ facts, legacy = false, className }: { facts: ServiceFacts; legacy?: boolean; className?: string }) {
  if (legacy) {
    return (
      <dl className={cn('facts', className)}>
        {factsLines(facts).map(([label, value]) => (
          <FactPair key={label} label={label} value={value} />
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn('m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 font-sans text-base sm:grid-cols-[minmax(7rem,10rem)_1fr]', className)}>
      {factsLines(facts).map(([label, value]) => (
        <FactPair key={label} label={label} value={value} lagoon />
      ))}
    </dl>
  );
}

function FactPair({ label, value, lagoon = false }: { label: string; value: string; lagoon?: boolean }) {
  return (
    <>
      <dt className={lagoon ? 'text-sm font-medium text-quiet' : undefined}>{label}</dt>
      <dd className={lagoon ? 'm-0 min-w-0 wrap-break-word whitespace-pre-wrap text-ink' : 'prewrap'}>{value}</dd>
    </>
  );
}

/** Progress of a Deal as a short status pill (icon + the frozen progress words). */
export function ProgressPill({ progress, wrap = true }: { progress: DealProgress; wrap?: boolean }) {
  const text = progressText(progress);
  const tone: StatusTone = progress.total === 0 ? 'neutral' : progress.fulfilled ? 'success' : progress.byState.planned === progress.total ? 'neutral' : 'info';
  const icon = progress.total === 0 ? Clock : progress.fulfilled ? CircleCheck : progress.byState.planned === progress.total ? Hourglass : PlayCircle;
  return (
    <StatusBadge tone={tone} icon={icon} wrap={wrap}>
      <span className="sr-only">Progress: </span>
      {text}
    </StatusBadge>
  );
}

/** A small hint line under a pill, e.g. the department label. */
export function QuietLine({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-sm text-quiet', className)}>{children}</span>;
}
