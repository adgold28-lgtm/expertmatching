/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enables instrumentation.ts's register() hook (Next 14 requires this flag;
  // the hook itself runs lib/validateEnv.ts at server boot — see that file).
  experimental: {
    instrumentationHook: true,
  },

  // Nothing in the app uses next/image, so the /_next/image optimizer endpoint
  // is attack surface with no job: with `unoptimized` set the server answers
  // 404 there instead of decoding attacker-supplied images (the 2026 AVIF
  // advisories, GHSA-2xp9-vwfh-vxw4, were in exactly that code path).
  images: {
    unoptimized: true,
  },

  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'X-XSS-Protection',
            value: '0',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
