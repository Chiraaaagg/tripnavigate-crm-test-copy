import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn';
import { controlClass } from './field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the value as wrong (aria-invalid). Pair with a FieldError. */
  invalid?: boolean;
  /** React 19 passes ref as a prop; it reaches the <input> through the props spread (focus management). */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, invalid, type = 'text', ...props }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(controlClass, className)}
      data-slot="input"
      {...props}
    />
  );
}
