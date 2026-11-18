'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PREFS_FIELD } from './labels';
import type { Language } from './types';

/*
 * Customer WhatsApp number (contract §5.3 A1, §15 screen 1), and the message
 * language as a hidden field. Used inside Book now (the contact step) and
 * inside the Deal card's "Change language or channels" dialog. Field names
 * are the A1 keys: `language`, `whatsappSameAsMobile` ("true" when ticked)
 * and `whatsappMobile` (sent only when the tick is off). Uncontrolled after
 * the first render, so a refusal keeps what was typed.
 *
 * Owner decision D12 (UX redesign R1): every customer message goes in
 * English, so there is no language choice any more. The form posts
 * `language=en`, the value the English choice posted before, so the saved
 * Deal stays valid; a Deal stored as Hindi becomes English the next time its
 * message settings are saved. The stored column and the sender are unchanged.
 */

/** The only message language (D12): the value the English radio button posted. */
export const MESSAGE_LANGUAGE = 'en' as const satisfies Language;

export function CustomerLanguageFields({
  idPrefix,
  defaultSameAsMobile = true,
  defaultWhatsapp = '',
  mobileHint,
  errorField,
}: {
  idPrefix: string;
  /** No longer shown (D12): the form always posts English. Kept so existing callers compile. */
  defaultLanguage?: Language;
  defaultSameAsMobile?: boolean;
  defaultWhatsapp?: string;
  /** e.g. "Mobile on the booking: 98xxxxxx12" (masked; never the full number). */
  mobileHint?: string;
  /** The field a refusal named (aria-invalid). */
  errorField?: string | null;
}) {
  const [same, setSame] = useState(defaultSameAsMobile);
  const waId = `${idPrefix}-whatsapp`;
  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name={PREFS_FIELD.language} value={MESSAGE_LANGUAGE} />
      <div className="flex flex-col gap-3">
        <input type="hidden" name={PREFS_FIELD.whatsappSameAsMobile} value={same ? 'true' : 'false'} />
        <Checkbox
          id={`${idPrefix}-same`}
          checked={same}
          onChange={(e) => setSame(e.currentTarget.checked)}
          label="WhatsApp number is the same as mobile"
          description={mobileHint}
        />
        {same ? null : (
          <Field htmlFor={waId} label="WhatsApp number" hint="10 digits, starting with 6, 7, 8 or 9. No +91.">
            <Input
              id={waId}
              name={PREFS_FIELD.whatsappMobile}
              inputMode="numeric"
              autoComplete="tel-national"
              pattern="[6-9][0-9]{9}"
              maxLength={10}
              required
              defaultValue={defaultWhatsapp}
              invalid={errorField === PREFS_FIELD.whatsappMobile}
              aria-describedby={`${waId}-hint`}
              className="max-w-xs"
            />
          </Field>
        )}
      </div>
    </div>
  );
}
