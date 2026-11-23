import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STATUS_ICONS } from '@/components/ui/badge';
import { STATUS_KINDS, STATUS_TABLE, Status, UNKNOWN_STATUS, statusTone } from '@/components/ui/status';

/**
 * C3: one status table (build plan 4.1, 4.3). Every kind has a tone, an icon
 * and words; tone is never the only signal; unknown kinds are neutral with a
 * clock, never a wrong colour.
 */

const TONES = new Set(Object.keys(STATUS_ICONS));

describe('status table', () => {
  it('has a closed, non-empty list of kinds in snake_case', () => {
    expect(STATUS_KINDS.length).toBeGreaterThan(40);
    for (const k of STATUS_KINDS) expect(k).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it.each(STATUS_KINDS)('%s has a tone, an icon and words', (kind) => {
    const look = statusTone(kind);
    expect(TONES.has(look.tone)).toBe(true);
    expect(look.icon).toBeTruthy();
    expect(['function', 'object']).toContain(typeof look.icon);
    expect(look.words.trim().length).toBeGreaterThan(1);
    expect(look.words[0]).toBe(look.words[0]!.toUpperCase());
  });

  it('gives each set of words to one kind only', () => {
    const words = STATUS_KINDS.map((k) => STATUS_TABLE[k].words.toLowerCase());
    expect(new Set(words).size).toBe(words.length);
  });

  it('shows an unknown kind as neutral with a clock and "Not known"', () => {
    for (const bad of ['no_such_kind', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(statusTone(bad as string)).toBe(UNKNOWN_STATUS);
    }
    expect(UNKNOWN_STATUS.tone).toBe('neutral');
    expect(UNKNOWN_STATUS.icon).toBe(STATUS_ICONS.neutral);
    expect(UNKNOWN_STATUS.words).toBe('Not known');
  });

  it('keeps the approved tones for the states staff see most', () => {
    expect(statusTone('overdue').tone).toBe('danger');
    expect(statusTone('returned_by_accounts').tone).toBe('warning');
    expect(statusTone('waiting_for_manager').tone).toBe('warning');
    expect(statusTone('verified').tone).toBe('success');
    expect(statusTone('in_progress').tone).toBe('info');
    expect(statusTone('not_taken').tone).toBe('neutral');
    expect(statusTone('on').tone).toBe('success');
    expect(statusTone('off').tone).toBe('neutral');
    expect(statusTone('not_known').tone).toBe('warning');
  });
});

describe('<Status>', () => {
  const html = (props: Parameters<typeof Status>[0]) => renderToStaticMarkup(createElement(Status, props));

  it('renders an icon (hidden from screen readers) and the words, never colour alone', () => {
    const out = html({ kind: 'overdue' });
    expect(out).toContain('data-tone="danger"');
    expect(out).toContain('data-kind="overdue"');
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(out).toContain('>Overdue<');
    expect(out).not.toMatch(/\sstyle="/);
  });

  it('uses the page words when given, and adds the second fact beside the badge', () => {
    const out = html({ kind: 'waiting_for_manager', label: 'Needs the branch Manager', second: 'Raised 6 Nov 2026' });
    expect(out).toContain('Needs the branch Manager');
    expect(out).not.toContain('Waiting for the Manager');
    expect(out).toContain('data-slot="status"');
    expect(out).toContain('Raised 6 Nov 2026');
  });

  it('marks an unknown kind and adds screen-reader words before the label', () => {
    const out = html({ kind: 'nope' as never, srPrefix: 'State: ' });
    expect(out).toContain('data-kind="unknown"');
    expect(out).toContain('data-tone="neutral"');
    expect(out).toContain('<span class="sr-only">State: </span>Not known');
  });
});
