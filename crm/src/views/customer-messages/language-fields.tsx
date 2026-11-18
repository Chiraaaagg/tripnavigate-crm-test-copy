'use client';

import { useState } from 'react';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LANGUAGE_LABEL, PREFS_FIELD } from './labels';
import type { Language } from './types';

/*
 * Customer language and WhatsApp number (contract §5.3 A1, §15 screen 1).
 * Used inside Book now (the contact step) and inside the Deal card's
 * "Change language or channels" dialog. Field names are the A1 keys:
 * `language`, `whatsappSameAsMobile` ("true" when ticked) and
 * `whatsappMobile` (sent only when the tick is off). Uncontrolled after the
 * first render, so a refusal keeps what was typed.
 */
export function CustomerLanguageFields({
  idPrefix,
  defaultLanguage = 'en',
  defaultSameAsMobile = true,
  defaultWhatsapp = '',
  mobileHint,
  errorField,
}: {
  idPrefix: string;
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
      <ChoiceGroup id={`${idPrefix}-language`} legend="Language for customer messages" hint="E-mail and WhatsApp messages go in this language. It can be changed later on the Deal page.">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(['en', 'hi'] as const).map((l) => (
            <Radio key={l} id={`${idPrefix}-language-${l}`} name={PREFS_FIELD.language} value={l} defaultChecked={defaultLanguage === l} label={LANGUAGE_LABEL[l]} />
          ))}
        </div>
      </ChoiceGroup>
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
