// scripts/fix-admin-org-domain.ts — move the platform-admin organization off a
// public email domain.
//
//   npx tsx scripts/fix-admin-org-domain.ts            (dry run)
//   npx tsx scripts/fix-admin-org-domain.ts --apply    (writes)
//
// The founder's admin organization was seeded with the domain of the admin's
// own address (gmail.com). lib/emailDomains.ts now refuses to treat a public
// domain as an organization anywhere, so the row is inert either way — but a
// row that SAYS gmail.com is a trap for the next reader. This renames it to
// expertmatch.fit (the product's own domain) and re-syncs every member's
// app_metadata (firm_domain) so sessions agree with the row.

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(path.resolve(__dirname, '..'), '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { isPublicEmailDomain } from '../lib/emailDomains';
import { syncUserMetadata } from '../lib/firmStore';

const TARGET = process.env.ADMIN_ORG_DOMAIN ?? 'expertmatch.fit';
const apply  = process.argv.includes('--apply');

(async () => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: orgs } = await db.from('organizations').select('id, domain, name');
  const offenders = (orgs ?? []).filter(o => o.domain && isPublicEmailDomain(o.domain));
  if (offenders.length === 0) { console.log('no organization is keyed on a public email domain'); return; }
  for (const org of offenders) {
    const { data: members } = await db.from('organization_members').select('profile_id, role').eq('organization_id', org.id);
    const { data: profiles } = await db.from('profiles').select('id, email, is_platform_admin').in('id', (members ?? []).map(m => m.profile_id));
    const isAdminOrg = (profiles ?? []).some(p => p.is_platform_admin);
    console.log(`${org.domain} → ${isAdminOrg ? TARGET : '(not the admin org — leave for manual review)'}  name="${org.name}" members=${(profiles ?? []).length}`);
    if (!apply || !isAdminOrg) continue;
    const { data: taken } = await db.from('organizations').select('id').eq('domain', TARGET).maybeSingle();
    if (taken) { console.log(`  ${TARGET} is already taken — not renaming`); continue; }
    const { error } = await db.from('organizations').update({ domain: TARGET }).eq('id', org.id);
    if (error) { console.log(`  rename failed: ${error.message}`); continue; }
    for (const p of profiles ?? []) await syncUserMetadata(p.email);
    console.log(`  renamed and re-synced ${(profiles ?? []).length} member(s)`);
  }
  if (!apply) console.log('\ndry run — re-run with --apply to write');
})();
