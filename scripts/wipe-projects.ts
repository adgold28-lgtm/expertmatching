import { getUpstashClient } from '../lib/upstashRedis';

async function main() {
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
