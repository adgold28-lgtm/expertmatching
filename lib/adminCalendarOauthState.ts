// Module-level OAuth state store for the one-time admin Google Calendar auth flow.
// Process-local — safe for a single-server one-time admin operation.
// Never logs the state value.

import { createHmac, randomBytes } from 'crypto';

let _oauthState: string | null = null;

export function getOrCreateOauthState(): string {
  if (_oauthState) return _oauthState;
  const nonce  = randomBytes(16).toString('hex');
  const secret = process.env.SESSION_SECRET ?? 'dev-session-secret';
  const sig    = createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 16);
  _oauthState  = `${nonce}.${sig}`;
  return _oauthState;
}

export function getOauthState(): string | null {
  return _oauthState;
}

export function clearOauthState(): void {
  _oauthState = null;
}
