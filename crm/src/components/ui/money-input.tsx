import { cn } from './cn';
import { Input, type InputProps } from './input';

/**
 * Rupee amount input: a visible ₹ prefix (decorative; the label says "₹" or
 * "rupees"), decimal keypad on phones, no browser number spinner. Values are
 * typed as rupees with up to two decimals; the server converts to whole paise.
 */
export function MoneyInput({ className, ...props }: Omit<InputProps, 'type' | 'inputMode'>) {
  return (
    <div className="relative" data-slot="money-input">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-sans text-base text-quiet">
        ₹
      </span>
      <Input type="text" inputMode="decimal" autoComplete="off" className={cn('pl-7 tabular-nums', className)} {...props} />
    </div>
  );
}
