import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn, focusRing } from './cn';

/**
 * Button styles. Use `buttonVariants()` on a Next.js <Link> for navigation
 * that looks like a button; use <Button> only for actions.
 * One `primary` button per screen (the screen's main action).
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap',
    'rounded-control border font-sans font-semibold no-underline select-none',
    'transition-[color,background-color,border-color] duration-(--ui-duration-quick) ease-calm motion-reduce:transition-none',
    'disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    focusRing,
  ],
  {
    variants: {
      variant: {
        primary:
          'border-brand-strong bg-brand-strong text-white shadow-button hover:border-brand-deep hover:bg-brand-deep hover:text-white',
        secondary:
          'border-line-strong bg-card text-ink shadow-none hover:border-line-strong hover:bg-wash hover:text-ink',
        ghost: 'border-transparent bg-transparent text-copy shadow-none hover:bg-wash hover:text-ink',
        danger:
          'border-status-danger bg-status-danger text-white shadow-button hover:border-status-danger-strong hover:bg-status-danger-strong hover:text-white',
        link: 'h-auto border-transparent bg-transparent p-0 text-brand-strong underline-offset-4 shadow-none hover:text-brand-deep hover:underline',
      },
      size: {
        sm: 'h-8 px-2.5 text-sm',
        md: 'h-10 px-3.5 text-base',
        lg: 'h-11 px-4 text-md',
        icon: 'size-10 p-0 text-base',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonVariantProps {
  /** React 19 passes ref as a prop; it reaches the <button> through the props spread (focus management). */
  ref?: Ref<HTMLButtonElement>;
  /** Shows a spinner, sets aria-busy and blocks further clicks. Keep the label (e.g. "Saving…"). */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-slot="button"
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="animate-ui-spin motion-reduce:animate-none" /> : null}
      {children}
    </button>
  );
}
