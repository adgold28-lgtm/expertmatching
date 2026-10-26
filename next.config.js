const { withSentryConfig } = require('@sentry/nextjs/config');

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

// Sentry's build plugin wraps route handlers, server components and middleware
// so an uncaught error is reported, and bundles instrumentation-client.ts into
// the browser entry (lib/sentry.ts says what is and is not sent). Source maps
// are uploaded only when a build has all three SENTRY_* variables; a local
// build or CI without them builds exactly as before and uploads nothing.
const sentryUploadConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

module.exports = withSentryConfig(nextConfig, {
  org:       process.env.SENTRY_ORG,
  project:   process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent:    !process.env.CI,
  telemetry: false,
  automaticVercelMonitors: false,
  // Nothing here uses tracing or session replay (lib/sentry.ts), so their
  // code is tree-shaken out of the browser bundle rather than shipped idle.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing:         true,
    excludeReplayShadowDom: true,
    excludeReplayIframe:    true,
    excludeReplayWorker:    true,
  },
  widenClientFileUpload:   sentryUploadConfigured,
  sourcemaps: {
    disable: !sentryUploadConfigured,
    // Uploaded maps live in Sentry; the deployed bundle does not ship them.
    deleteSourcemapsAfterUpload: true,
  },
});
