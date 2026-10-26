// Findymail find-email-from-name provider — the first link in the discovery
// chain (lib/contactDiscovery.ts), ahead of Hunter.
//
// One call: POST /api/search/name with the person's full name and the company
// domain. Findymail verifies before it answers, so an address it returns is
// deliverable and is stored as 'verified'; it has no confidence score and no
// per-address status, so none is stored. A miss costs nothing ("uses one
// finder credit if a verified email is found").
//
// API key is server-side only — NEVER exposed to the client or the logs. It
// rides in the Authorization header and nowhere else.
// API docs: https://app.findymail.com/docs ("Find email from name")
//
// Documented errors: 402 "Not enough credits" and 423 "Subscription is
// paused". A 200 whose contact carries no address is the only thing read as
// "nobody by that name at that domain". Every other answer throws — with a
// code for the two the chain treats specially, without one otherwise — so a
// key problem, a paused subscription or an unexpected status is recorded as
// an error and never cached as not_found.

import type { ContactProvider, ContactLookupInput, ProviderEmailResult } from './types';
import { WEBMAIL_DOMAINS } from './types';
import { boundedController } from './deadline';
import { log } from '../log';

const ENDPOINT = 'https://app.findymail.com/api/search/name';

export const findymailProvider: ContactProvider = {
  name: 'findymail',

  isConfigured(): boolean {
    return Boolean(process.env.FINDYMAIL_API_KEY);
  },

  async findProfessionalEmail({ firstName, lastName, domain, signal }: ContactLookupInput): Promise<ProviderEmailResult[]> {
    // THIS IS WHERE A FINDYMAIL CREDIT MAY BE SPENT (on a hit only)
    const apiKey = process.env.FINDYMAIL_API_KEY;
    if (!apiKey) throw new Error('FINDYMAIL_API_KEY not set');

    const name = `${firstName} ${lastName}`.trim();
    if (!name || !domain) return [];

    const { controller, cleanup } = boundedController(10_000, signal);

    try {
      const res = await fetch(ENDPOINT, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body:   JSON.stringify({ name, domain }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw Object.assign(new Error('Findymail upstream rate limit'), { code: 'provider_rate_limited' });
      }

      if (res.status === 402) {
        throw Object.assign(new Error('Insufficient Findymail credits'), { code: 'not_enough_credits' });
      }

      // The key is wrong or revoked, or the subscription is paused. Throwing
      // (rather than returning []) keeps a configuration problem out of the
      // negative cache — discoverContact only caches 'not_found' when a
      // provider actually answered not_found.
      if (res.status === 401) throw new Error('Findymail API key invalid or revoked');
      if (res.status === 423) throw new Error('Findymail subscription is paused');

      if (!res.ok) {
        throw new Error(`Findymail HTTP ${res.status}`);
      }

      const body    = await res.json() as Record<string, unknown>;
      const contact = body.contact as Record<string, unknown> | null | undefined;
      const email   = contact && typeof contact.email === 'string' ? contact.email.trim() : '';
      if (!email) return [];

      const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';

      // Filter webmail — security invariant enforced at provider level
      const isWebmail = WEBMAIL_DOMAINS.has(emailDomain);
      if (isWebmail) return [];

      // Findymail returns only valid-format emails, but be defensive
      const isValidFormat = email.includes('@') && emailDomain.includes('.');

      // Debug audit: counts only — no email, domain, API key, or raw response logged
      log.info('[findymail]', 'result-counts', {
        returned:         1,
        normalizedStatus: 'verified',
        isWebmail,
        isValidFormat,
      });

      return [{
        email,
        provider:         'findymail',
        providerStatus:   'verified',   // Findymail only answers with addresses it verified
        normalizedStatus: 'verified',
        isWebmail,
        isDisposable:     false,
        isValidFormat,
        isGibberish:      false,
        reason:           null,
      }];
    } finally {
      cleanup();
    }
  },

  estimateCreditsPerLookup(_input: ContactLookupInput): number {
    return 1;
  },
};
