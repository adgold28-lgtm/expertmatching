// lib/contactInfo.ts — the one place the support address lives.
//
// Every page that tells a person how to reach us reads it from here: the
// contact page, the terms and privacy policies, the Stripe Connect return and
// expired-link pages, and the onboarding billing step. Change the address by
// setting NEXT_PUBLIC_SUPPORT_EMAIL (NEXT_PUBLIC_ because client components
// render it, so Next inlines the value at build time); the fallback is the
// address that was hardcoded in six places before this module existed.

const DEFAULT_SUPPORT_EMAIL = 'ashergoldsteinbusiness@gmail.com';

/** Where a client, an expert or a regulator can reach a human. */
export const SUPPORT_EMAIL: string =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
