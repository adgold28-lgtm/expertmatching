// lib/emailDomains.ts — which email domains can stand for an organization.
//
// ExpertMatch derives an organization from an email domain in two places: the
// public access-request form (does the requester's firm already exist?) and
// account provisioning (which organization does an invitee join when the
// caller names none?). Both used to trust any domain, which meant an
// organization keyed on `gmail.com` — the founder's own admin org — made every
// Gmail address in the world a colleague of the platform admin.
//
// A public (freemail) domain is never an organization. Anyone whose only
// address is on one of these has to be placed into an organization explicitly
// by a platform admin, who names the organization (trial testers get a
// generated one — see lib/entitlements.ts / app/api/admin/users).
//
// The list is deliberately generous: a domain wrongly treated as public costs
// one extra admin click; a public domain wrongly treated as an organization is
// an open door.

const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'live.com', 'live.co.uk', 'msn.com', 'passport.com',
  // Yahoo / AOL
  'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.fr', 'yahoo.de', 'yahoo.co.in', 'ymail.com',
  'rocketmail.com', 'aol.com', 'aim.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-first
  'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me', 'tutanota.com', 'tutamail.com', 'tuta.io',
  'hushmail.com', 'duck.com', 'mozmail.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'posteo.de',
  // Other large consumer providers
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'email.com', 'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'inbox.com', 'qq.com', '163.com', '126.com', 'sina.com',
  'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com', 'lycos.com', 'excite.com',
  // US ISPs
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'charter.net', 'earthlink.net', 'optonline.net', 'frontier.com', 'windstream.net',
  // UK / EU ISPs
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'orange.fr', 'free.fr',
  'laposte.net', 'wanadoo.fr', 't-online.de', 'libero.it', 'virgilio.it', 'telenet.be',
  // Disposable / testing
  'mailinator.com', 'guerrillamail.com', 'sharklasers.com', 'yopmail.com', 'temp-mail.org',
  'example.com', 'example.org', 'example.net',
]);

/** Lower-cases and strips a leading "@" / "www." so callers can pass either form. */
export function normalizeEmailDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '').replace(/^www\./, '');
}

/** The domain part of an email address, normalized; '' when there is none. */
export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return normalizeEmailDomain(email.slice(at + 1));
}

/**
 * True for a consumer / freemail / disposable domain — one that many
 * unrelated people share, so it can never identify an organization.
 */
// Callers: lib/accountProvisioning (refuses to create an org on a freemail
// domain), lib/firmStore.isApprovedDomain (a consumer domain is never approved,
// whatever rows exist), app/api/request-access and the admin users/requests
// routes. This is the choke point that closed the gmail.com open-registration
// hole, so a `false` returned here is a security decision, not a UI nicety.
export function isPublicEmailDomain(domain: string): boolean {
  const d = normalizeEmailDomain(domain);
  if (!d) return true;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return true;
  // "gmail.com" spelled as a subdomain ("mail.gmail.com") is still Gmail.
  return Array.from(PUBLIC_EMAIL_DOMAINS).some(known => d.endsWith('.' + known));
}

/**
 * The organization domain an address may IMPLY on its own, or null when the
 * address is on a public domain and the organization has to be named
 * explicitly.
 */
export function impliedOrgDomainFor(email: string): string | null {
  const d = emailDomainOf(email);
  if (!d || isPublicEmailDomain(d)) return null;
  return d;
}
