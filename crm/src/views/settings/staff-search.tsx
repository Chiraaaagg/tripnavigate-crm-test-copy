'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/*
 * Staff search (R1 review): the Staff list is loaded whole, so the search
 * filters the rows in the browser. Names and work e-mails never go into the
 * address (and so never into access logs). Each row carries its own search
 * text in `data-search` (name and e-mail, lower case); rows that do not match
 * are hidden, and a polite status line says how many are shown. Without
 * script the box does nothing and every row stays visible.
 */
export function StaffSearch({ total, children }: { total: number; children: ReactNode }) {
  const id = useId();
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(total);
  const box = useRef<HTMLDivElement>(null);

  // Filter when the words change (an event, not an effect): hide the rows that do not match and count the rest.
  const search = (value: string) => {
    setQ(value);
    const words = value.trim().toLowerCase();
    let n = 0;
    box.current?.querySelectorAll<HTMLElement>('[data-search]').forEach((row) => {
      const match = !words || (row.dataset.search ?? '').includes(words);
      row.hidden = !match;
      if (match) n += 1;
    });
    setShown(n);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="px-4.5">
        <Field htmlFor={`${id}-q`} label="Search staff" hint="Name or work email. Filters this list; nothing is sent.">
          <Input id={`${id}-q`} type="search" value={q} onChange={(e) => search(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-q-hint ${id}-count`} />
        </Field>
        <p id={`${id}-count`} role="status" className="m-0 mt-1.5 text-sm text-quiet">
          {q.trim() ? (shown === 0 ? 'Nobody matches this search.' : `${shown} of ${total} shown.`) : null}
        </p>
      </div>
      <div ref={box}>{children}</div>
    </div>
  );
}
