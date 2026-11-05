'use client';

import { getNonce, setNonce } from 'get-nonce';

/**
 * Hands the document's Content Security Policy nonce to `get-nonce`, which
 * react-style-singleton (used by Radix Dialog's scroll lock) reads before it
 * inserts its small <style> tag. Without the nonce the production policy
 * (style-src 'self' 'nonce-…') blocks that tag.
 *
 * The nonce is read ONCE, from the scripts of the loaded document (their
 * `nonce` property keeps the value even after the browser hides the
 * attribute). It is never taken from a later render: router.refresh() or a
 * revalidating server action re-renders the layout for a new request with a
 * new nonce that does not match this document's policy. Renders nothing; on
 * the server it does nothing (the module value would be shared by requests).
 */
export function NonceBridge() {
  if (typeof window !== 'undefined' && !getNonce()) {
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    if (nonce) setNonce(nonce);
  }
  return null;
}
