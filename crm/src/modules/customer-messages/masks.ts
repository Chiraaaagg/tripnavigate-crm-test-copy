/**
 * Masks (contract 5.4 `to_masked`), the same as authz.cmsg_mask_mobile /
 * authz.cmsg_mask_email: the full value never survives.
 */

/** 6000012345 -> 60xxxxxx45 */
export function maskMobile(mobile: string | null | undefined): string | null {
  const m = (mobile ?? '').replace(/\D/g, '').slice(-10);
  return /^\d{10}$/.test(m) ? `${m.slice(0, 2)}xxxxxx${m.slice(-2)}` : null;
}

/** pooja@example.test -> p***@example.test */
export function maskEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim();
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@') || at === e.length - 1 || /\s/.test(e)) return null;
  return `${e[0]}***@${e.slice(at + 1)}`;
}
