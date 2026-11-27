import type { MetadataRoute } from 'next';

/**
 * Web app manifest (Accounts phase 3 contract 8.4, LD20): lets iPhone users
 * add the CRM to the Home Screen, the only place iOS allows closed-browser
 * alerts. No offline support, no install prompt; the start page needs a
 * signed-in session like every staff page.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TripNavigate CRM',
    short_name: 'TripNavigate',
    description: 'Holiday Chacha staff CRM',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f5c5a',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
