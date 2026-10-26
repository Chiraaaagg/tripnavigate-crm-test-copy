import { CircleAlert } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn, focusRing } from './cn';

/** Native checkbox and radio, tinted with the brand colour (accent-color). */
const choiceInput = cn(
  'm-0 mt-0.5 size-4 min-h-0 shrink-0 cursor-pointer p-0 accent-brand-strong disabled:cursor-not-allowed',
  focusRing,
);

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  /** Small text under the label (linked with aria-describedby). */
  description?: ReactNode;
  invalid?: boolean;
}

function Choice({ type, id, label, description, invalid, className, disabled, ...props }: ChoiceProps & { type: 'checkbox' | 'radio'; id: string }) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn('flex items-start gap-2.5 font-sans', className)} data-slot={type}>
      <input
        id={id}
        type={type}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={descriptionId}
        className={choiceInput}
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className={cn('text-base font-medium text-ink', disabled ? 'cursor-not-allowed text-quiet' : 'cursor-pointer')}>
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="text-sm text-quiet">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Checkbox(props: ChoiceProps & { id: string }) {
  return <Choice type="checkbox" {...props} />;
}

export function Radio(props: ChoiceProps & { id: string }) {
  return <Choice type="radio" {...props} />;
}

/** Groups radios or checkboxes under a visible legend. */
export function ChoiceGroup({
  id,
  legend,
  hint,
  error,
  className,
  children,
}: {
  /** Used for the hint and error ids the fieldset points at. */
  id: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset
      className={cn('m-0 min-w-0 border-0 p-0 font-sans', className)}
      aria-describedby={describedBy}
    >
      <legend className="mb-2 p-0 text-base font-semibold text-ink">{legend}</legend>
      {hint ? (
        <p id={hintId} className="m-0 mb-2 text-sm text-quiet">
          {hint}
        </p>
      ) : null}
      <div className="flex flex-col gap-2.5">{children}</div>
      {error ? (
        <p id={errorId} className="m-0 mt-2.5 flex items-start gap-1.5 text-sm font-medium text-status-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
