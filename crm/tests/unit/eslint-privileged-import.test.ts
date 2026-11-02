import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd });

async function restricted(code: string, filePath: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error('ESLint returned no result');
  return result.messages.some((m) => m.ruleId === 'no-restricted-imports');
}

// The privileged (secret-key) Supabase client may only be imported from src/modules/**/server/**.
describe('ESLint privileged import rule', () => {
  // Loading the Next.js ESLint config takes several seconds the first time.
  beforeAll(async () => {
    await eslint.lintText('export {};\n', { filePath: 'src/views/warm-up.ts' });
  }, 120_000);

  const outside = 'src/views/example-view.tsx';
  it.each([
    "import { createSupabaseAdminClient } from '@/lib/supabase/admin';",
    "import { createSupabaseAdminClient } from '../lib/supabase/admin';",
    "import { createSupabaseAdminClient } from '@/lib/supabase/admin.ts';",
    "export { createSupabaseAdminClient } from '../lib/supabase/admin';",
  ])('refuses %s outside server modules', async (code) => {
    expect(await restricted(`${code}\nexport const x = 1;\n`, outside)).toBe(true);
  });

  it('allows the import inside a server module', async () => {
    const code = "import { createSupabaseAdminClient } from '@/lib/supabase/admin';\nexport const x = createSupabaseAdminClient;\n";
    expect(await restricted(code, 'src/modules/access/server/example.ts')).toBe(false);
  });
});
