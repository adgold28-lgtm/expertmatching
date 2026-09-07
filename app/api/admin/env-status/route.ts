// GET /api/admin/env-status — platform admins only.
//
// Replaces the retired /demo-readiness page. Answers one question: is every
// variable this app refuses to boot without actually SET in this environment?
//
// PRESENCE ONLY. A value never leaves the server — not a prefix, not a length,
// not a masked form. The response is a boolean per variable, grouped by the
// system the variable belongs to so a missing Stripe key is obvious at a
// glance. The list itself is lib/validateEnv.REQUIRED_VARS, so this can never
// disagree with what the server enforces at startup.
//
// Guarded twice: adminGuard here, and middleware.ts turns /api/admin/* into a
// 404 for anyone who is not an admin, so the route's existence is not confirmed.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { REQUIRED_VARS } from '../../../../lib/validateEnv';

export interface EnvVarStatus {
  name: string;
  set:  boolean;
}

export interface EnvGroup {
  name: string;
  vars: EnvVarStatus[];
}

// Prefix → group. Order is the order the groups come back in; 'Other' catches
// everything that does not belong to one of the named systems.
const GROUPS: ReadonlyArray<{ name: string; prefix: string }> = [
  { name: 'Supabase', prefix: 'SUPABASE' },
  { name: 'Stripe',   prefix: 'STRIPE'   },
  { name: 'Resend',   prefix: 'RESEND'   },
  { name: 'QStash',   prefix: 'QSTASH'   },
  { name: 'Zoom',     prefix: 'ZOOM'     },
  { name: 'Google',   prefix: 'GOOGLE'   },
  { name: 'Upstash',  prefix: 'UPSTASH'  },
];

const OTHER = 'Other';

/**
 * The group a variable belongs to.
 *
 * `NEXT_PUBLIC_` is stripped first: `NEXT_PUBLIC_SUPABASE_URL` is a Supabase
 * variable, and grouping it under its visibility prefix would hide it from the
 * Supabase row where someone would look for it.
 */
function groupFor(name: string): string {
  const bare = name.startsWith('NEXT_PUBLIC_') ? name.slice('NEXT_PUBLIC_'.length) : name;
  return GROUPS.find(g => bare.startsWith(g.prefix))?.name ?? OTHER;
}

export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  const byGroup = new Map<string, EnvVarStatus[]>();
  for (const name of REQUIRED_VARS) {
    const group = groupFor(name);
    const list  = byGroup.get(group) ?? [];
    // Boolean, never the value. An empty string counts as unset — that is what
    // validateEnv() treats as missing too.
    list.push({ name, set: !!process.env[name] });
    byGroup.set(group, list);
  }

  const ordered = [...GROUPS.map(g => g.name), OTHER];
  const groups: EnvGroup[] = ordered
    .filter(name => byGroup.has(name))
    .map(name => ({ name, vars: byGroup.get(name) ?? [] }));

  return Response.json({ groups });
}
