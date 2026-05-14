// One-off diagnostic: find all ProjectExpert records where availabilitySubmitted === true.
// Logs expertId, projectId, and calendarProvider for each match.
//
// Run:
//   npx ts-node scripts/check-availability.ts
//   npx tsx scripts/check-availability.ts           (also works)
//
// Reads credentials from .env.local automatically if not already in the environment.

import * as fs   from 'fs';
import * as path from 'path';
import { UpstashRedis } from '../lib/upstashRedis';
import type { Project }  from '../types';

// ─── .env.local loader ────────────────────────────────────────────────────────
// Minimal parser — no dotenv dependency.
// Only sets keys that are absent from process.env (shell vars take precedence).

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;

  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let   val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvLocal();

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.error('Error: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set.');
    console.error('Place them in .env.local or export them before running this script.');
    process.exit(1);
  }

  const redis = new UpstashRedis(url, token);

  // ── 1. Load the project index ──────────────────────────────────────────────
  console.log('Fetching project index…');
  const indexRaw = await redis.get('projects:index');

  if (!indexRaw) {
    console.log('projects:index is empty — no projects found.');
    return;
  }

  let summaries: Array<{ id: string }>;
  try {
    summaries = JSON.parse(indexRaw) as Array<{ id: string }>;
  } catch {
    console.error('Failed to parse projects:index JSON.');
    process.exit(1);
  }

  console.log(`Found ${summaries.length} project(s). Scanning for submitted availability…\n`);

  // ── 2. Fetch all project documents in one pipeline call ───────────────────
  const cmds = summaries.map(s => ['GET', `project:${s.id}`] as [string, ...unknown[]]);
  const results = await redis.pipeline(cmds);

  // ── 3. Scan every ProjectExpert ────────────────────────────────────────────
  type Match = { projectId: string; expertId: string; calendarProvider: string };
  const matches: Match[] = [];

  for (let i = 0; i < results.length; i++) {
    const raw = results[i].result as string | null;
    if (!raw) continue;

    let project: Project;
    try {
      project = JSON.parse(raw) as Project;
    } catch {
      console.warn(`  [skip] project:${summaries[i].id} — could not parse JSON`);
      continue;
    }

    for (const pe of project.experts) {
      if (pe.availabilitySubmitted === true) {
        matches.push({
          projectId:        project.id,
          expertId:         pe.expert.id,
          calendarProvider: pe.calendarProvider ?? '(not set)',
        });
      }
    }
  }

  // ── 4. Report ──────────────────────────────────────────────────────────────
  if (matches.length === 0) {
    console.log('No records with availabilitySubmitted === true found.');
    return;
  }

  console.log(`${matches.length} submitted availability record(s):\n`);
  for (const m of matches) {
    console.log(`  projectId:        ${m.projectId}`);
    console.log(`  expertId:         ${m.expertId}`);
    console.log(`  calendarProvider: ${m.calendarProvider}`);
    console.log('');
  }
}

main().catch(err => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
