/*
 * Referral draft words shared by server and client views (a plain module, no
 * 'use client', so server components can call it too).
 */

/** DA-213: the title an empty Title field prints; the same default the server uses ("Trip for {customer name}"). */
export function defaultReferralTitle(customerName: string): string {
  const name = customerName.trim();
  return name ? `Trip for ${name}` : 'Trip for {customer name}';
}
