import type { Ref, TextareaHTMLAttributes } from 'react';
import { cn } from './cn';
import { controlClass } from './field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** React 19 passes ref as a prop; it reaches the <textarea> through the props spread. */
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, invalid, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(controlClass, 'min-h-24 resize-y leading-relaxed', className)}
      data-slot="textarea"
      {...props}
    />
  );
}
