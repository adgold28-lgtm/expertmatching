// lib/adminNotifications.ts — who ExpertMatch staff are, for the emails the
// platform sends to itself (a new access request, a firm that hit its seat
// limit).
//
// One env var, ADMIN_NOTIFICATION_EMAIL, holding one address or a
// comma-separated list. Nothing is hardcoded: before this module the
// request-access route carried the founder's personal addresses in source,
// in a public repository, and changing who gets notified meant a deploy.
//
// Unset means "nobody is emailed". That is a deliberate quiet failure, not an
// error: every notification this feeds is a convenience on top of a record
// that is stored anyway (access requests live in `access_requests` and show in
// the admin Requests page). lib/validateEnv.ts warns at boot when the variable
// is missing in production so the gap is visible without reading mail.

/** Lower-cased, de-duplicated, syntactically plausible addresses. */
export function adminNotificationEmails(): string[] {
  const raw = process.env.ADMIN_NOTIFICATION_EMAIL ?? '';
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const address = part.trim().toLowerCase();
    if (address.includes('@') && !address.startsWith('@') && !address.endsWith('@')) seen.add(address);
  }
  return Array.from(seen);
}
