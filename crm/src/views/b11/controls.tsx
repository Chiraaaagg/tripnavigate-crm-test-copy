'use client';

import type { ReactNode } from 'react';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';

/*
 * Controlled field wrappers for the B1.1 forms: label, control, hint and the
 * error text tied with aria-describedby; aria-invalid only for a blocking
 * problem. The value lives in the form's state, so it survives refusals.
 */

interface BaseProps {
  id: string;
  name: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  disabled?: boolean;
  className?: string;
  /** Associates the control with a form elsewhere on the page (the form attribute). */
  form?: string;
  /** Beside the label (Field `aside`), e.g. the "From Bitrix" marker. */
  aside?: ReactNode;
  /** Under the field (Field `extra`), e.g. the "Bitrix now says …" line. */
  extra?: ReactNode;
}

export function TextField({
  type = 'text',
  inputMode,
  autoComplete = 'off',
  maxLength,
  min,
  max,
  ...p
}: BaseProps & { type?: 'text' | 'email' | 'tel' | 'date' | 'time' | 'number' | 'datetime-local'; inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email'; autoComplete?: string; maxLength?: number; min?: number | string; max?: number | string }) {
  return (
    <Field htmlFor={p.id} label={p.label} hint={p.hint} error={p.error ?? undefined} optional={p.optional} className={p.className} aside={p.aside} extra={p.extra}>
      <Input
        id={p.id}
        name={p.name}
        type={type}
        inputMode={inputMode ?? (type === 'number' ? 'numeric' : undefined)}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        invalid={Boolean(p.error)}
        aria-describedby={fieldDescribedBy(p.id, { hint: p.hint, error: p.error })}
        autoComplete={autoComplete}
        maxLength={maxLength}
        min={min}
        max={max}
        disabled={p.disabled}
        form={p.form}
      />
    </Field>
  );
}

export function MoneyField(p: BaseProps) {
  return (
    <Field htmlFor={p.id} label={p.label} hint={p.hint} error={p.error ?? undefined} optional={p.optional} className={p.className} aside={p.aside} extra={p.extra}>
      <MoneyInput
        id={p.id}
        name={p.name}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        invalid={Boolean(p.error)}
        aria-describedby={fieldDescribedBy(p.id, { hint: p.hint, error: p.error })}
        disabled={p.disabled}
      />
    </Field>
  );
}

export function AreaField({ rows = 3, maxLength, ...p }: BaseProps & { rows?: number; maxLength?: number }) {
  return (
    <Field htmlFor={p.id} label={p.label} hint={p.hint} error={p.error ?? undefined} optional={p.optional} className={p.className} aside={p.aside} extra={p.extra}>
      <Textarea
        id={p.id}
        name={p.name}
        rows={rows}
        value={p.value}
        maxLength={maxLength}
        onChange={(e) => p.onChange(e.target.value)}
        invalid={Boolean(p.error)}
        aria-describedby={fieldDescribedBy(p.id, { hint: p.hint, error: p.error })}
        disabled={p.disabled}
      />
    </Field>
  );
}

export function SelectField({ options, ...p }: BaseProps & { options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <Field htmlFor={p.id} label={p.label} hint={p.hint} error={p.error ?? undefined} optional={p.optional} className={p.className} aside={p.aside} extra={p.extra}>
      <Select
        id={p.id}
        name={p.name}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        invalid={Boolean(p.error)}
        aria-describedby={fieldDescribedBy(p.id, { hint: p.hint, error: p.error })}
        disabled={p.disabled}
        form={p.form}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Native checkbox with label and optional description (value "on" when ticked). */
export function CheckField({
  id,
  name,
  label,
  description,
  checked,
  onChange,
  error,
  disabled,
  className,
}: {
  id: string;
  name: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const describedBy = [description ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1 font-sans', className)}>
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          name={name}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className="m-0 mt-0.5 size-4 min-h-0 shrink-0 cursor-pointer accent-brand-strong outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong"
        />
        <label htmlFor={id} className="cursor-pointer text-base text-ink">
          {label}
        </label>
      </div>
      {description ? (
        <p id={`${id}-hint`} className="m-0 pl-6.5 text-sm text-quiet">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="m-0 pl-6.5 text-sm font-medium text-status-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Field error for a refused field name: the generic text unless the form gives a specific one. */
export function problemFor(fields: readonly string[] | undefined, name: string, text: string): string | null {
  return fields?.includes(name) ? text : null;
}
