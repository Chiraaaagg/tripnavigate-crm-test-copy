'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PREFS_FIELD } from './labels';

/*
 * Small client parts of the A1 preferences form (contract 5.3). Track A's
 * action changes only the keys present in the form, so:
 * - a channel tick always sends "true" or "false" (an unticked box alone
 *   would send nothing and the channel would stay off);
 * - the corrected e-mail is sent only when something is typed (an empty box
 *   would clear an earlier correction).
 */

export function ChannelOffBox({ id, name, defaultChecked, label }: { id: string; name: typeof PREFS_FIELD.whatsappOff | typeof PREFS_FIELD.emailOff; defaultChecked: boolean; label: string }) {
  const [on, setOn] = useState(defaultChecked);
  return (
    <>
      <Checkbox id={id} checked={on} onChange={(e) => setOn(e.currentTarget.checked)} label={label} />
      <input type="hidden" name={name} value={on ? 'true' : 'false'} />
    </>
  );
}

export function EmailOverrideField({ id }: { id: string }) {
  const [value, setValue] = useState('');
  return (
    <Field htmlFor={id} label="Corrected e-mail" optional hint="Only when the e-mail on the booking is wrong. Leave empty to keep it.">
      <Input id={id} name={value.trim() ? PREFS_FIELD.emailOverride : undefined} type="email" autoComplete="off" value={value} onChange={(e) => setValue(e.currentTarget.value)} aria-describedby={`${id}-hint`} />
    </Field>
  );
}

/** Sent only when typed, so saving the language alone keeps an earlier reason. */
export function OffReasonField({ id }: { id: string }) {
  const [value, setValue] = useState('');
  return (
    <Field htmlFor={id} label="Reason for switching a channel off" optional hint="Needed when you switch a channel off. 10 to 300 characters.">
      <Input id={id} name={value.trim() ? PREFS_FIELD.offReason : undefined} maxLength={300} value={value} onChange={(e) => setValue(e.currentTarget.value)} aria-describedby={`${id}-hint`} />
    </Field>
  );
}
