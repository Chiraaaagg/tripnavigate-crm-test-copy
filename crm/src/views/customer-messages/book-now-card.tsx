'use client';

import { MessageSquareText } from 'lucide-react';
import { isSessionEnded, SignInNewTabLink } from '../b11/session-link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskResultLine, useDeskCommand } from '@/views/accounts-desk/desk-kit';
import { PREFS_FIELD } from './labels';
import { CustomerLanguageFields } from './language-fields';
import type { Language } from './types';

/*
 * Book now › "Messages to the customer" (contract §5.3 A1, LD4, §15 screen 1).
 * Language and WhatsApp number live on the Deal, not on the booking draft,
 * so this is its own small form on the contact step with its own "Save".
 * The row version from each confirmed save is kept, so a second save in the
 * same visit is not refused as changed. A refusal keeps what was typed.
 */

export interface BookNowPrefs {
  dealId: string;
  language: Language;
  whatsappSameAsMobile: boolean;
  /** Masked number shown in the hint, never the full number. */
  whatsappMasked: string | null;
  rowVersion: number;
}

export function BookNowMessagePrefsCard({ prefs, action }: { prefs: BookNowPrefs; action: DecisionAction | null }) {
  const [rowVersion, setRowVersion] = useState(prefs.rowVersion);
  const cmd = useDeskCommand(action ?? (async () => ({ ok: false, code: 'not_authorized', message: 'Not available to you.' })));
  const field = cmd.state && !cmd.state.ok ? ((cmd.state as { field?: string }).field ?? null) : null;
  return (
    <Card id="book-message-prefs" className="mt-4.5">
      <section aria-labelledby="book-message-prefs-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="book-message-prefs-heading">Messages to the customer</CardTitle>
            <CardDescription>Saved on the Deal, separate from the booking. Every message is in English.</CardDescription>
          </div>
          <MessageSquareText aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody>
          <form
            noValidate
            onSubmit={(e) =>
              cmd.submit(e, (r) => {
                if (r.ok) {
                  const data = (r as { data?: { rowVersion?: number } }).data;
                  if (typeof data?.rowVersion === 'number') setRowVersion(data.rowVersion);
                }
              })
            }
            className="flex flex-col gap-4"
          >
            <input type="hidden" name={PREFS_FIELD.dealId} value={prefs.dealId} />
            <input type="hidden" name={PREFS_FIELD.expectedRowVersion} value={rowVersion} />
            <input type="hidden" name="requestId" value={cmd.requestId} />
            <CustomerLanguageFields
              idPrefix="book-prefs"
              defaultLanguage={prefs.language}
              defaultSameAsMobile={prefs.whatsappSameAsMobile}
              mobileHint={prefs.whatsappMasked ? `WhatsApp now: ${prefs.whatsappMasked}` : 'The mobile number on the booking.'}
              errorField={field}
            />
            <div className="flex flex-col items-start gap-2">
              {action ? (
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  aria-disabled={cmd.pending || undefined}
                  onClick={(e) => {
                    if (cmd.pending) e.preventDefault();
                  }}
                >
                  {cmd.pending ? 'Saving…' : 'Save message settings'}
                </Button>
              ) : (
                <p className="m-0 text-sm text-quiet">Only the Sales owner or the branch Manager can change these.</p>
              )}
              <DeskResultLine state={cmd.state} okTitle="Saved" />
              {cmd.state && !cmd.state.ok && isSessionEnded(cmd.state as { code?: string; message?: string }) ? <SignInNewTabLink /> : null}
            </div>
          </form>
        </CardBody>
      </section>
    </Card>
  );
}

/** The language / WhatsApp read failed: say so on the customer step instead of hiding the card. */
export function BookNowMessagePrefsUnavailable() {
  return (
    <Notice tone="warning" role="status" className="mt-4.5">
      <p>Message settings could not be loaded. You can set them later on the Deal page.</p>
    </Notice>
  );
}
