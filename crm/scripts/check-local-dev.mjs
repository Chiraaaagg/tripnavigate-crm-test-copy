import { createRequire } from 'node:module';

// Use the same environment-file precedence as the installed Next.js version.
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
const { loadEnvConfig } = nextRequire('@next/env');
loadEnvConfig(process.cwd(), true);

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
let hostedDatabase = false;
try {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    hostedDatabase = !localHosts.has(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname);
  }
} catch {
  console.error('Invalid Supabase URL. Check local settings before starting development.');
  process.exit(1);
}

if (process.env.LOCAL_USE_PRODUCTION_DATABASE === 'true' || hostedDatabase) {
  console.error('Development cannot use the business database. Keep the database guard enabled.');
  console.error('For the existing local production build, use npm run start -- --hostname 127.0.0.1 --port 3000.');
  console.error('Before rebuilding changes, stop its production server, run npm run build, then start it again. Development tests require an isolated loopback database.');
  process.exit(1);
}
