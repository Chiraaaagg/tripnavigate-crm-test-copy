import { type BrowserContext, expect } from '@playwright/test';
import { buildCspDirectives } from '../../src/lib/csp';

/**
 * Production style policy on the local dev server, for design-preview pages
 * that exist only under `next dev` (the gallery, preview states). `next dev`
 * relaxes style-src to 'unsafe-inline', which would hide server-rendered style
 * attributes and un-nonced <style> tags. script-src stays the dev one because
 * the dev runtime needs 'unsafe-eval'; the production script-src is proven by
 * csp.prod.e2e.ts against a production build.
 */

/**
 * A document fulfilled by Playwright carries no server address, so Chromium's
 * Local Network Access check treats it as public and blocks its requests to
 * 127.0.0.1 (scripts, the HMR socket): the page would never hydrate. Test
 * browsers using the rewrite only ever talk to the loopback dev server.
 */
export const LOCAL_NETWORK_ACCESS_OFF = { launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } };

function parseCsp(header: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

/**
 * Serves matching documents with the production style-src for their own
 * nonce (style-src 'self' 'nonce-…', no 'unsafe-inline'), built by
 * src/lib/csp.ts. Every rewritten policy is appended to `applied`.
 */
export async function enforceProductionStylePolicy(context: BrowserContext, applied: string[], matches: (url: URL) => boolean) {
  await context.route(
    matches,
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      const headers = response.headers();
      const original = headers['content-security-policy'];
      expect(original, 'dev server sends a Content Security Policy').toBeTruthy();
      const csp = parseCsp(original!);
      const nonceToken = csp.get('script-src')?.find((v) => v.startsWith("'nonce-"));
      expect(nonceToken, 'script-src nonce').toBeTruthy();
      const nonce = nonceToken!.slice(7, -1);
      const production = buildCspDirectives({ nonce, isDev: false, upgradeInsecureRequests: false });
      csp.set('style-src', production['style-src']!);
      expect(csp.get('style-src')).not.toContain("'unsafe-inline'");
      const rewritten = [...csp.entries()].map(([name, values]) => [name, ...values].join(' ')).join('; ');
      applied.push(rewritten);
      await route.fulfill({ response, headers: { ...headers, 'content-security-policy': rewritten } });
    },
  );
}

/**
 * Records every securitypolicyviolation event. The ONE exclusion: the Next.js
 * development tools (<nextjs-portal> overlay), whose script is the compiled
 * next-devtools chunk, inject un-nonced <style> tags. They exist only under
 * `next dev`, never in a production build, and are not part of the page.
 * Those events are counted separately, identified by their source script.
 */
export async function trackViolations(context: BrowserContext): Promise<{ violations: string[]; devOverlay: string[] }> {
  const violations: string[] = [];
  const devOverlay: string[] = [];
  await context.exposeFunction('__reportCspViolation', (v: string, source: string, target: string) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\/_next\/static\/chunks\/node_modules_next_dist_compiled_next-devtools_[^/]+\.js$/.test(source)) {
      devOverlay.push(`${v} (element ${target})`);
    }
    else violations.push(`${v} (source ${source || 'document'}, element ${target || 'none'})`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const target = e.target instanceof Element ? e.target.tagName : '';
      (
        window as unknown as { __reportCspViolation: (v: string, source: string, target: string) => void }
      ).__reportCspViolation(
        `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} ${e.sample ?? ''}`,
        e.sourceFile ?? '',
        target,
      );
    });
  });
  return { violations, devOverlay };
}
