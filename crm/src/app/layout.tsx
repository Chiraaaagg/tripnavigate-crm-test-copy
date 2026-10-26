import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { NonceBridge } from '@/components/ui/nonce-bridge';
import { getAppConfig } from '@/lib/config';
import { inter, interExtended } from './fonts';
import './app.css';

export const metadata: Metadata = {
  title: { default: 'TripNavigate CRM', template: '%s · TripNavigate CRM' },
  description: 'Internal staff workspace for Holiday Chacha Pvt LTD.',
  robots: { index: false, follow: false },
};

/**
 * Every page renders per request: the proxy's Content Security Policy carries
 * a fresh nonce that Next.js applies to its scripts and styles while
 * rendering, which a statically prerendered page could not carry.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const appEnv = process.env.APP_ENV;
  // The live-database banner follows the VALIDATED operating mode only. An
  // invalid configuration shows the default banner; every Supabase-backed
  // request then fails closed in lib/config.ts.
  let liveDatabase = false;
  try {
    liveDatabase = getAppConfig().localProductionDatabase;
  } catch {
    liveDatabase = false;
  }
  return (
    <html lang="en-IN" className={`${inter.variable} ${interExtended.variable}`}>
      <body>
        <NonceBridge />
        <a className="skip-link z-60" href="#main">
          Skip to main content
        </a>
        {liveDatabase ? (
          <div className="env-banner" role="note">
            Local production build: connected to the live company database. Changes are real.
          </div>
        ) : appEnv && appEnv !== 'production' ? (
          <div className="env-banner" role="note">
            {appEnv === 'staging' ? 'Staging' : 'Local development'} environment: synthetic data only. Do not
            enter real customer or traveller information.
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
