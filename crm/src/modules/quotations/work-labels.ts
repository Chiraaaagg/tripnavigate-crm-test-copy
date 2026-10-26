import type { ReferralSourceKind } from './work-contract';

/*
 * Referral draft labels shared by server view models and client forms.
 * Kept free of zod and other runtime imports: a client bundle that pulls in
 * zod triggers its eval feature check, which the strict CSP blocks and reports.
 */

export const REFERRAL_SOURCE_LABEL: Record<ReferralSourceKind, string> = {
  walk_in: 'Walk-in',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  email: 'Email',
  referral: 'Referral',
  repeat_customer: 'Repeat customer',
  social: 'Social media',
  other: 'Other',
};

export const REFERRAL_CLOSE_REASON_LABEL = {
  duplicate: 'Duplicate',
  lost: 'Customer not going ahead',
  handled_elsewhere: 'Handled elsewhere',
  other: 'Other',
} as const;

export const REFERRAL_UNLINK_REASON_LABEL = { wrong_link: 'Wrong customer', duplicate: 'Duplicate', other: 'Other' } as const;
