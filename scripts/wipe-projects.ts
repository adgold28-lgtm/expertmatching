// scripts/wipe-projects.ts — DESTRUCTIVE. Deletes every project, project
// index/lock, access-request, and signup-token/rate-limit key in the target
// Upstash Redis (the pre-Supabase project store; see lib/upstashRedis.ts).
// It wipes whatever UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN point at.
//
//   npx tsx scripts/wipe-projects.ts
//
// ENVIRONMENT GUARD (audit H-22): the script prints the resolved Upstash host
// before touching anything and REFUSES to run when that host is not localhost
// or 127.0.0.1 unless ALLOW_PROD=1 is set. There is still no confirmation
// prompt and no dry run, so read the printed host before you set ALLOW_PROD.
//
// No dotenv load here — vars must already be in the environment (e.g. via
// `set -a && source .env.local && set +a` first).
//
// NOTE: this targets the Redis project store that Postgres replaced. Nothing
// the product reads today lives in these keys.
import { getUpstashClient } from '../lib/upstashRedis';
import { requireSafeTarget } from './opsGuard';

async function main() {
  requireSafeTarget('wipe-projects', [
    { label: 'Upstash', url: process.env.UPSTASH_REDIS_REST_URL },
  ]);

  const redis = getUpstashClient();
  if (!redis) {
    console.error('No Upstash client — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  const patterns = [
    'project:*',
    'projects:index',
    'projects:lock',
    'access-request:*',
    'access-requests:list',
    'signup-token:*',
    'signup-rl:*',
  ];

  let totalDeleted = 0;

  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      const deleted = await redis.delMany(keys);
      console.log(`  ${pattern}: deleted ${deleted} key(s)`);
      totalDeleted += deleted;
    } else {
      console.log(`  ${pattern}: nothing to delete`);
    }
  }

  console.log(`\nTotal keys deleted: ${totalDeleted}`);
  console.log('All projects wiped successfully');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
