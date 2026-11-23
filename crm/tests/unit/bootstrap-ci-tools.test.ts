import { describe, expect, it } from 'vitest';
import {
  chunkForAnnotations,
  decodeAnnotation,
  encodeAnnotation,
  stripLeadingCommentHeader,
} from '../../scripts/ci/annotations.mjs';

/** CI tooling used by the real-stack jobs (type drift check, result annotations). */
describe('GitHub annotation encoding', () => {
  it('encodes % before CR/LF and round-trips', () => {
    const text = '100% done\r\nnext line\n%0A literal';
    const encoded = encodeAnnotation(text);
    expect(encoded).toBe('100%25 done%0D%0Anext line%0A%250A literal');
    expect(decodeAnnotation(encoded)).toBe(text);
  });

  it('chunks by encoded size and reassembles exactly', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i} 50%\n`).join('');
    const chunks = chunkForAnnotations(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(encodeAnnotation(c).length).toBeLessThanOrEqual(1000);
    expect(chunks.map((c) => decodeAnnotation(encodeAnnotation(c))).join('')).toBe(text);
    expect(chunkForAnnotations('')).toEqual(['']);
  });

  it('ignores only a leading // header when comparing generated types', () => {
    const generated = 'export type Json = string;\n// inner comment\n';
    expect(stripLeadingCommentHeader(`// header\n// more\n\n${generated}`)).toBe(generated);
    expect(stripLeadingCommentHeader(generated)).toBe(generated);
  });

});

describe('real-stack harness helpers', () => {
  it('parses the /auth/accept POST form as React renders it', async () => {
    const { parsePostForm, hasAuthCookie, cookieHeader } = await import('../helpers/real-stack');
    const html =
      '<main><form method="get" action="/search"><input name="q" value="x"/></form>' +
      '<form method="post" action="/auth/confirm"><input type="hidden" name="type" value="recovery"/>' +
      '<input type="hidden" name="token_hash" value="pkce_abc&amp;def"/><button type="submit">Continue</button></form></main>';
    expect(parsePostForm(html)).toEqual({
      action: '/auth/confirm',
      method: 'post',
      enctype: 'application/x-www-form-urlencoded',
      fields: { type: 'recovery', token_hash: 'pkce_abc&def' },
    });
    expect(parsePostForm('<p>no form</p>')).toBeNull();
    const cookies = ['sb-127-auth-token=base64-abc; Path=/; HttpOnly', 'other=1; Path=/'];
    expect(hasAuthCookie(cookies)).toBe(true);
    expect(hasAuthCookie(['sb-127-auth-token=; Max-Age=0'])).toBe(false);
    expect(cookieHeader(cookies)).toBe('sb-127-auth-token=base64-abc; other=1');
  });

  it('real-stack configuration fails instead of skipping when REQUIRE_REAL_STACK=1 (T16)', async () => {
    const { resolveRealStackEnv } = await import('../helpers/real-stack');
    expect(resolveRealStackEnv({})).toBeNull();
    expect(() => resolveRealStackEnv({ REQUIRE_REAL_STACK: '1' })).toThrow(/APP_BASE_URL/);
    expect(() =>
      resolveRealStackEnv({
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'x',
        SUPABASE_SECRET_KEY: 'y',
        LOCAL_FIXTURE_PASSWORD: 'z',
        APP_BASE_URL: 'http://127.0.0.1:3000',
      }),
    ).toThrow(/local stack/);
  });
});
