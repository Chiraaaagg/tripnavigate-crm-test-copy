import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/**
 * UX redesign R0 (build plan 4.9): counts what a person does in one journey.
 *
 *   clicks       every click or tap the person makes (menu items, tabs, buttons, links, rows);
 *   typed        every field the person fills or picks a value in (a select counts as a field, not a click);
 *   page loads   every full document load after the journey starts (sign-in is not counted);
 *   screens      every in-app address change, full loads and client-side moves together;
 *   scrolls      every time the next control was outside the visible window and the person had to
 *                scroll to reach it, counted in window heights (rounded up).
 *
 * Playwright scrolls a control into view on its own before acting; the scroll count
 * measures that distance before the action, so it reports what a person would scroll.
 */
export interface Counts {
  journey: string;
  slice: string;
  clicks: number;
  typed: number;
  pageLoads: number;
  screens: number;
  scrolls: number;
  source: 'real stack' | 'preview gallery';
  steps: string[];
}

export class Counter {
  readonly counts: Counts;
  private started = false;

  constructor(private readonly page: Page, journey: string, slice: string, source: Counts['source'] = 'real stack') {
    this.counts = { journey, slice, clicks: 0, typed: 0, pageLoads: 0, screens: 0, scrolls: 0, source, steps: [] };
    page.on('load', () => {
      if (this.started) this.counts.pageLoads++;
    });
    page.on('framenavigated', (frame) => {
      if (this.started && frame === page.mainFrame()) this.counts.screens++;
    });
  }

  /** The journey starts here: the person is on this page already. */
  start() {
    this.started = true;
  }

  private async scrollNeeded(target: Locator): Promise<number> {
    await target.waitFor({ state: 'visible' });
    return target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const h = window.innerHeight;
      if (r.bottom <= h && r.top >= 0) return 0;
      // Distance from the visible window to the control, in window heights (at least one).
      const distance = r.top < 0 ? -r.top : r.bottom - h;
      return Math.max(1, Math.ceil(distance / h));
    });
  }

  private async note(target: Locator, what: string) {
    const scrolls = await this.scrollNeeded(target);
    this.counts.scrolls += scrolls;
    this.counts.steps.push(scrolls ? `${what} (after ${scrolls} scroll)` : what);
  }

  async click(target: Locator, what: string) {
    await this.note(target, `click: ${what}`);
    this.counts.clicks++;
    await target.click();
  }

  async fill(target: Locator, value: string, what: string) {
    await this.note(target, `type: ${what}`);
    this.counts.typed++;
    await target.fill(value);
  }

  async select(target: Locator, value: string | { label: string }, what: string) {
    await this.note(target, `pick: ${what}`);
    this.counts.typed++;
    await target.selectOption(value);
  }

  async upload(target: Locator, file: { name: string; mimeType: string; buffer: Buffer }, what: string) {
    // A file box is reached and clicked like a button, then the file is chosen in the system dialog.
    this.counts.clicks++;
    this.counts.typed++;
    this.counts.steps.push(`choose file: ${what}`);
    await target.setInputFiles(file);
  }
}

/** Appends one journey's counts to the results file (one JSON object per line) and returns the table line. */
export function record(file: string, counts: Counts): string {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const kept = lines.filter((l) => (JSON.parse(l) as Counts).journey !== counts.journey);
  writeFileSync(file, [...kept, JSON.stringify(counts)].join('\n') + '\n');
  return `| ${counts.journey} | ${counts.slice} | ${counts.clicks} | ${counts.typed} | ${counts.pageLoads} | ${counts.screens} | ${counts.scrolls} | ${counts.source} |`;
}
