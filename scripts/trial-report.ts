// scripts/trial-report.ts — what one trial tester actually did.
//
//   npx tsx scripts/trial-report.ts tester@example.com
//   npx tsx scripts/trial-report.ts --org trial-ab12cd.expertmatch.fit
//   npx tsx scripts/trial-report.ts --all          (every trial organization, one line each)
//
// Read-only. Joins profiles, organization_members, organization_billing,
// projects, project_experts and product_events into a timeline and a funnel:
// invited → activated → signed in → onboarded → project → brief → sourcing →
// candidates → bookmark/pass → hit the paywall. Prints no expert identity and
// no brief text.

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(path.resolve(__dirname, '..'), '.env.local') });
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const FUNNEL = [
  'account_invited', 'account_activated', 'signed_in', 'onboarding_completed', 'project_created',
  'brief_saved', 'sourcing_started', 'sourcing_completed', 'candidate_bookmarked', 'candidate_passed',
  'restricted_action_attempted', 'went_live',
] as const;

function when(iso: string | null | undefined): string { return iso ? iso.replace('T', ' ').slice(0, 16) : '—'; }

async function reportOrg(orgId: string, verbose: boolean): Promise<void> {
  const { data: org } = await db.from('organizations').select('id, name, domain, created_at').eq('id', orgId).maybeSingle();
  if (!org) { console.log('organization not found'); return; }
  const { data: billing } = await db.from('organization_billing').select('billing_complete, subscription_status, updated_at').eq('organization_id', orgId).maybeSingle();
  const kind = billing?.billing_complete ? 'customer (card on file)' : billing?.subscription_status === 'trialing' ? 'TRIAL' : 'customer (no card)';
  const { data: members } = await db.from('organization_members').select('profile_id, role, status, created_at').eq('organization_id', orgId);
  const ids = (members ?? []).map(m => m.profile_id);
  const { data: profiles } = await db.from('profiles').select('id, email, first_name, last_name, onboarding_complete, created_at').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const { data: auth } = await db.auth.admin.listUsers({ perPage: 1000 });
  const lastSignIn = new Map((auth?.users ?? []).map(u => [u.id, u.last_sign_in_at ?? null]));
  const { data: projects } = await db.from('projects').select('id, name, owner_id, brief, created_at, updated_at').eq('organization_id', orgId);
  const { data: events, error: evErr } = await db.from('product_events').select('type, actor_id, project_id, payload, created_at').eq('organization_id', orgId).order('created_at');
  const { data: actorEvents } = ids.length ? await db.from('product_events').select('type, actor_id, project_id, payload, created_at').in('actor_id', ids).order('created_at') : { data: [] };
  const all = new Map<string, { type: string; actor_id: string | null; project_id: string | null; payload: unknown; created_at: string }>();
  for (const e of [...(events ?? []), ...(actorEvents ?? [])]) all.set(`${e.created_at}|${e.type}|${e.actor_id}`, e);
  const timeline = Array.from(all.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));

  console.log(`\n=== ${org.name} · ${org.domain} · ${kind} · created ${when(org.created_at)} ===`);
  for (const p of profiles ?? []) {
    const m = (members ?? []).find(x => x.profile_id === p.id);
    console.log(`  ${p.email}  ${p.first_name ?? ''} ${p.last_name ?? ''}  ${m?.role ?? '-'}/${m?.status ?? '-'}  onboarded=${p.onboarding_complete}  created ${when(p.created_at)}  last sign-in ${when(lastSignIn.get(p.id))}`);
  }
  console.log(`  projects: ${(projects ?? []).length}`);
  for (const p of projects ?? []) {
    const brief = (p.brief ?? {}) as { walkthrough?: boolean; sourcingStatus?: string; briefUpdatedAt?: number };
    const { data: experts } = await db.from('project_experts').select('status').eq('project_id', p.id);
    const dist: Record<string, number> = {};
    for (const e of experts ?? []) dist[e.status] = (dist[e.status] ?? 0) + 1;
    console.log(`    ${p.id}  "${p.name}"  mode=${brief.walkthrough === false ? 'LIVE' : 'walkthrough'}  sourcing=${brief.sourcingStatus ?? '-'}  experts=${(experts ?? []).length} ${JSON.stringify(dist)}  brief saved ${brief.briefUpdatedAt ? when(new Date(brief.briefUpdatedAt).toISOString()) : '—'}  updated ${when(p.updated_at)}`);
  }
  if (evErr) { console.log(`  product_events: not available (${evErr.message.slice(0, 80)}) — apply migration 20260908`); return; }
  const counts: Record<string, number> = {};
  for (const e of timeline) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log('  funnel: ' + FUNNEL.map(t => `${t}=${counts[t] ?? 0}`).join('  '));
  const reached = FUNNEL.filter(t => (counts[t] ?? 0) > 0);
  console.log(`  furthest step: ${reached.length ? reached[reached.length - 1] : '(nothing recorded)'}`);
  if (verbose) {
    console.log('  timeline:');
    for (const e of timeline) {
      const who = (profiles ?? []).find(p => p.id === e.actor_id)?.email ?? (e.actor_id ? e.actor_id.slice(0, 8) : 'system');
      console.log(`    ${when(e.created_at)}  ${e.type.padEnd(28)} ${who.padEnd(34)} ${e.project_id ?? ''} ${JSON.stringify(e.payload)}`);
    }
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--all') {
    const { data: rows } = await db.from('organization_billing').select('organization_id').eq('subscription_status', 'trialing').eq('billing_complete', false);
    if (!rows?.length) { console.log('no trial organizations'); return; }
    for (const r of rows) await reportOrg(r.organization_id, false);
    return;
  }
  if (args[0] === '--org') {
    const { data: org } = await db.from('organizations').select('id').eq('domain', args[1] ?? '').maybeSingle();
    if (!org) { console.log('organization not found'); return; }
    await reportOrg(org.id, true);
    return;
  }
  const email = (args[0] ?? '').trim().toLowerCase();
  if (!email) { console.log('usage: npx tsx scripts/trial-report.ts <email> | --org <domain> | --all'); process.exit(2); }
  const { data: profile } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
  if (!profile) { console.log('no account with that email'); return; }
  const { data: m } = await db.from('organization_members').select('organization_id').eq('profile_id', profile.id).limit(1).maybeSingle();
  if (!m) { console.log('account has no organization'); return; }
  await reportOrg(m.organization_id, true);
})();
