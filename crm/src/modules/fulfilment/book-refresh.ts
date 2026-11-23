/**
 * Who re-renders Book now after a successful draft save (booking reliability
 * B1-6). Exactly one party refreshes: the client (one router.refresh()) when
 * 'client', the server action (refresh() from next/cache) when 'server'.
 * Status changes (start, submit, confirm, revision, discard, Bitrix refresh)
 * keep their revalidatePath calls in either mode.
 *
 * Set once by the lead after measurement M0 (build contract addendum). Until
 * then nothing reads it, and behaviour is today's.
 */
export const BOOK_SAVE_REFRESH_MODE: 'client' | 'server' = 'client';
