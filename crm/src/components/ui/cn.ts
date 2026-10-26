import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the design tokens (src/components/ui/tokens.css), so
 * that, for example, `rounded-control` and `rounded-full` are recognised as
 * the same property and the later class wins.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['md'],
      radius: ['chip', 'control', 'card', 'panel'],
      shadow: ['button', 'card', 'raised', 'overlay'],
      'font-weight': ['display'],
      tracking: ['display', 'heading', 'label'],
      ease: ['calm'],
      animate: [
        'ui-fade-in',
        'ui-fade-out',
        'ui-pop-in',
        'ui-pop-out',
        'ui-slide-in-right',
        'ui-slide-out-right',
        'ui-slide-in-left',
        'ui-slide-out-left',
        'ui-pulse',
        'ui-spin',
      ],
    },
  },
});

/** Joins class names (clsx) and resolves Tailwind conflicts (later wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Visible keyboard focus for every interactive element of the design system:
 * a 2px brand-strong outline (brand blue, 8.13:1 on white) with a 2px gap. box-shadow is
 * reset because the legacy stylesheet adds a dark ring on :focus-visible.
 */
export const focusRing =
  'outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-brand-strong focus-visible:shadow-none';
