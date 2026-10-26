import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // `next dev` only trusts localhost by default; this project serves (and its
  // invitation links point) at 127.0.0.1:3000. Without this the dev HMR socket
  // is refused and client components never hydrate. Development only.
  allowedDevOrigins: ['127.0.0.1'],
  // B1.2 online PDF maker (switched off unless PDF_RENDER_ONLINE=on): the
  // serverless Chromium binary is loaded at run time, so the build trace must
  // include it for the render worker route only.
  outputFileTracingIncludes: {
    '/api/integrations/render/worker': ['./node_modules/@sparticuz/chromium/bin/**/*'],
  },
  experimental: {
    // Booking proof uploads (EVIDENCE_MAX_BYTES = 4 MiB) go through a server
    // action and the proxy. Kept under the hosted function request-body cap.
    serverActions: { bodySizeLimit: '5mb' },
    proxyClientMaxBodySize: '5mb',
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Authenticated pages must never be cached by shared caches.
      { source: '/app/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    ];
  },
};

export default nextConfig;
