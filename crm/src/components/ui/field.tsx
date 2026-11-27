import { CircleAlert } from 'lucide-react';
import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** Shared look of text inputs, textareas and native selects. */
export const controlClass = cn(
  'block w-full min-h-10 rounded-control border border-control bg-card px-3 py-2 font-sans text-lg text-ink sm:text-base',
  'm-0 appearance-none shadow-none transition-[border-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
  'placeholder:text-faint hover:border-quiet',
  // Focus: a solid 2px brand-strong outline (visible in forced-colors mode, 5.47:1), plus the border colour.
  'outline-none focus:border-brand-strong focus:outline-2 focus:outline-offset-1 focus:outline-solid focus:outline-brand-strong',
  'disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-quiet',
  'aria-invalid:border-2 aria-invalid:border-status-danger aria-invalid:focus:border-status-danger aria-invalid:focus:outline-status-danger',
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('block font-sans text-base font-semibold text-ink', className)} {...props} />;
}

export function FieldHint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('m-0 font-sans text-sm text-quiet', className)} {...props} />;
}

/** Error text under a control. Give it an id and point the control's aria-describedby at it. */
export function FieldError({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('m-0 flex items-start gap-1.5 font-sans text-sm font-medium text-status-danger', className)} {...props}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export interface FieldProps {
  /** id of the control inside; used for the label and the hint/error ids. */
  htmlFor: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Adds "(optional)" after the label. Required is the default expectation. */
  optional?: boolean;
  className?: string;
  /** Small control beside the label, outside the label element (for example a "From Bitrix" details toggle). */
  aside?: ReactNode;
  /** Content under the hint and error, inside the field column (for example a one-line notice). */
  extra?: ReactNode;
  children: ReactNode;
}

/**
 * Label, control, hint and error in one column. The control must carry
 * aria-describedby={describedBy(id, { hint, error })} and aria-invalid when
 * there is an error; fieldDescribedBy() builds the ids.
 */
export function Field({ htmlFor, label, hint, error, optional, className, aside, extra, children }: FieldProps) {
  const labelEl = (
    <Label htmlFor={htmlFor}>
      {label}
      {optional ? <span className="font-normal text-quiet"> (optional)</span> : null}
    </Label>
  );
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-slot="field">
      {aside ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {labelEl}
          {aside}
        </div>
      ) : (
        labelEl
      )}
      {children}
      {hint ? <FieldHint id={`${htmlFor}-hint`}>{hint}</FieldHint> : null}
      {error ? <FieldError id={`${htmlFor}-error`}>{error}</FieldError> : null}
      {extra}
    </div>
  );
}

/** aria-describedby value matching the ids Field gives its hint and error. */
export function fieldDescribedBy(id: string, parts: { hint?: unknown; error?: unknown }): string | undefined {
  const ids = [parts.hint ? `${id}-hint` : null, parts.error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
