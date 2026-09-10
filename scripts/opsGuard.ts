// scripts/opsGuard.ts — the environment guard the three destructive operational
// scripts share (audit H-22).
//
// wipe-projects, seed-admin and smoke-cutover act on whatever Supabase and
// Upstash credentials happen to be exported in the shell. A developer with
// production variables in a profile could wipe production project data, write a
// real admin account, or sign the founder out of every live session by running
// what looks like a diagnostic. None of the three printed what it was about to
// act on.
//
// The rule: print every host the script resolved, and refuse to continue when
// any of them is not local unless the caller sets ALLOW_PROD=1. It is a
// speed bump, not a security boundary — anyone who can export the credentials
// can also export ALLOW_PROD — but it makes the target explicit and makes
// touching production a deliberate act.
//
// Usage:
//   requireSafeTarget('wipe-projects', [
//     { label: 'Upstash', url: process.env.UPSTASH_REDIS_REST_URL },
//   ]);

/** One resolved endpoint the script is about to act on. */
export interface OpsTarget {
  label: string;
  url:   string | undefined;
}

/** localhost, 127.0.0.1, ::1 and *.localhost are the only hosts treated as safe. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost'
    || h.endsWith('.localhost')
    || h === '127.0.0.1'
    || h === '::1';
}

/** The hostname of a URL, or null when it is absent or unparseable. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/**
 * Print the resolved hosts and exit(1) when any is non-local without
 * ALLOW_PROD=1. A target whose URL is unset prints as "not set" and is not
 * treated as remote — the script's own checks decide whether it can run at all
 * without it.
 */
export function requireSafeTarget(scriptName: string, targets: OpsTarget[]): void {
  const resolved = targets.map(t => ({ ...t, host: hostOf(t.url) }));

  console.log(`\n[${scriptName}] target environment:`);
  for (const t of resolved) {
    console.log(`  ${t.label.padEnd(10)} ${t.host ?? (t.url ? 'unparseable URL' : 'not set')}`);
  }

  const remote = resolved.filter(t => t.host !== null && !isLocalHost(t.host));
  if (remote.length === 0) return;

  if (process.env.ALLOW_PROD === '1') {
    console.log(`  ALLOW_PROD=1 — proceeding against ${remote.map(t => t.host).join(', ')}\n`);
    return;
  }

  console.error(
    `\n[${scriptName}] REFUSING TO RUN: ${remote.map(t => `${t.label} is ${t.host}`).join(', ')}, ` +
    'which is not localhost.\n' +
    'If that really is the environment you meant, re-run with ALLOW_PROD=1.\n',
  );
  process.exit(1);
}
