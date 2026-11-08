import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from './cn';

/** Text wordmark: "Trip" in ink, "Navigate" in brand-strong (brand blue), Inter 650, -0.02em. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-sans text-xl leading-none font-display tracking-display text-ink', className)}>
      Trip<span className="text-brand-strong">Navigate</span>
    </span>
  );
}

export interface NavItem {
  href: string;
  label: string;
  /** A lucide icon element, e.g. <House />. It is hidden from screen readers. */
  icon: ReactNode;
  current?: boolean;
  /** Optional count of waiting items; read out as "label, N waiting". */
  count?: number;
}

export interface NavSection {
  /** Optional group heading, e.g. "Back office". */
  label?: string;
  items: NavItem[];
}

/** The list of section links, used by the desktop sidebar and the mobile drawer. */
export function SidebarNav({ sections, label = 'Sections' }: { sections: NavSection[]; label?: string }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-1 font-sans" data-slot="sidebar-nav">
      {sections.map((section, index) => (
        <div key={section.label ?? index}>
          {section.label ? (
            <p className="m-0 px-2.5 pt-3.5 pb-1.5 text-xs font-semibold tracking-label text-faint uppercase">{section.label}</p>
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {section.items.map((item) => (
              <li key={item.href} className="m-0">
                <Link
                  href={item.href}
                  aria-current={item.current ? 'page' : undefined}
                  className={cn(
                    'flex min-h-10 items-center gap-2.5 rounded-control px-2.5 py-2 text-base font-medium text-quiet no-underline',
                    'transition-[color,background-color,border-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
                    'hover:bg-wash hover:text-ink',
                    'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
                    '[&_svg]:size-4.5 [&_svg]:shrink-0 aria-[current=page]:[&_svg]:text-brand-strong',
                    focusRing,
                  )}
                >
                  <span aria-hidden="true" className="contents">
                    {item.icon}
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {typeof item.count === 'number' ? (
                    <span className="rounded-full bg-wash px-1.5 text-xs leading-5 font-medium text-quiet tabular-nums">
                      <span className="sr-only">, </span>
                      {item.count}
                      <span className="sr-only"> waiting</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Desktop sidebar (hidden under 1024px; use MobileNav there). Quiet white
 * column: wordmark, grouped links, footer slot (e.g. signed-in person).
 */
export function Sidebar({
  sections,
  footer,
  className,
}: {
  sections: NavSection[];
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-label="Main menu"
      className={cn(
        'sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 border-r border-line bg-card px-3 py-4.5 lg:flex',
        className,
      )}
    >
      <div className="px-2.5 pt-1 pb-4.5">
        <Wordmark />
      </div>
      <SidebarNav sections={sections} />
      {footer ? <div className="mt-auto border-t border-line px-2.5 pt-2.5 text-sm text-quiet">{footer}</div> : null}
    </aside>
  );
}
