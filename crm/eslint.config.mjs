import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'],
  },
  {
    // The privileged Supabase client may only be imported by server modules.
    files: ['src/**/*.tsx', 'src/**/*.ts'],
    ignores: ['src/lib/supabase/admin.ts', 'src/modules/**/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@/lib/supabase/admin', message: 'Privileged client: import only from src/modules/**/server/**.' },
            {
              // Content Security Policy: other Radix parts (Checkbox, RadioGroup, Select, Tabs,
              // Toast viewport, ...) server-render style attributes or un-nonced style tags.
              // Use the native controls and own components in src/components/ui instead.
              name: 'radix-ui',
              allowImportNames: ['Dialog', 'DropdownMenu', 'Tooltip', 'Slot', 'Popover'],
              message: 'Only Radix Dialog, DropdownMenu, Tooltip, Popover and Slot are allowed (CSP); see src/components/ui.',
            },
          ],
          // Relative and extension-suffixed specifiers reach the same module.
          patterns: [
            {
              group: ['**/lib/supabase/admin', '**/lib/supabase/admin.*'],
              message: 'Privileged client: import only from src/modules/**/server/**.',
            },
            {
              group: ['@radix-ui/*'],
              message: "Import Radix through 'radix-ui' (only Dialog, DropdownMenu, Tooltip, Popover, Slot).",
            },
          ],
        },
      ],
    },
  },
];

export default config;
