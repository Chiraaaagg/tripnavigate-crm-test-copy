import { describe, expect, it } from 'vitest';
import { buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { fieldDescribedBy } from '@/components/ui/field';

describe('cn()', () => {
  it('joins conditional classes', () => {
    expect(cn('a', false && 'b', null, undefined, ['c', { d: true, e: false }])).toBe('a c d');
  });

  it('lets the later Tailwind class win for the same property', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    expect(cn('text-quiet', 'text-ink')).toBe('text-ink');
  });

  it('knows the design-token scales (radius, shadow, type size, weight)', () => {
    expect(cn('rounded-control', 'rounded-full')).toBe('rounded-full');
    expect(cn('rounded-card', 'rounded-panel')).toBe('rounded-panel');
    expect(cn('shadow-card', 'shadow-overlay')).toBe('shadow-overlay');
    expect(cn('text-base', 'text-md')).toBe('text-md');
    expect(cn('font-semibold', 'font-display')).toBe('font-display');
    // A type size and a colour are different properties: both stay.
    expect(cn('text-md', 'text-brand-strong')).toBe('text-md text-brand-strong');
  });
});

describe('buttonVariants()', () => {
  it('defaults to a medium secondary button with the focus ring', () => {
    const classes = buttonVariants();
    expect(classes).toContain('bg-card');
    expect(classes).toContain('h-10');
    for (const part of focusRing.split(' ')) expect(classes).toContain(part);
  });

  it('primary uses brand-strong (text-safe) and never the 3.74:1 brand teal as a fill', () => {
    const classes = buttonVariants({ variant: 'primary' });
    expect(classes).toContain('bg-brand-strong');
    expect(classes).not.toMatch(/(^|\s)bg-brand(\s|$)/);
  });

  it('sizes map to fixed heights', () => {
    expect(buttonVariants({ size: 'sm' })).toContain('h-8');
    expect(buttonVariants({ size: 'lg' })).toContain('h-11');
    expect(buttonVariants({ size: 'icon' })).toContain('size-10');
  });

  it('a className override wins through cn()', () => {
    expect(cn(buttonVariants({ size: 'md' }), 'h-12')).toContain('h-12');
    expect(cn(buttonVariants({ size: 'md' }), 'h-12')).not.toContain('h-10');
  });
});

describe('fieldDescribedBy()', () => {
  it('lists the hint and error ids that <Field> renders', () => {
    expect(fieldDescribedBy('x', {})).toBeUndefined();
    expect(fieldDescribedBy('x', { hint: 'h' })).toBe('x-hint');
    expect(fieldDescribedBy('x', { hint: 'h', error: 'e' })).toBe('x-hint x-error');
  });
});

describe('focus outline overrides', () => {
  it('a later inset offset replaces focusRing’s 2px offset (Home next-step rows)', () => {
    const classes = cn(focusRing, 'focus-visible:outline-offset-[-2px]').split(' ');
    expect(classes).toContain('focus-visible:outline-offset-[-2px]');
    expect(classes).not.toContain('focus-visible:outline-offset-2');
  });
});
