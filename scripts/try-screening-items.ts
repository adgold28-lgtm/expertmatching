// scripts/try-screening-items.ts — run the LLM step of the screening flow for
// real, once, and print what came back verbatim.
//
//   ANTRHOPICKEYREAL=sk-ant-... npx tsx scripts/try-screening-items.ts
//   (or put the key in .env.local — the script loads it like the other scripts)
//
// WHAT THIS IS FOR. lib/screeningItems.ts is exercised offline by
// scripts/test-screening-items.ts with a stubbed model; nothing in that suite
// proves that `claude-opus-5` answers on the pinned SDK (0.54.0) with the
// `output_config` typed cast, or what the real stems and proof prompts look
// like. This script is the one place that makes the real call, with the five
// objectives the founder asked to see (2026-09-15), and prints every stem and
// every proof prompt exactly as generated — plus whether each item came from
// the model or fell back, and why.
//
// It spends one to three model calls (the initial call plus up to
// MAX_REGENERATION_ATTEMPTS regenerations) and writes nothing anywhere.
// A runtime error from the API is printed as-is, never papered over.

import * as fs   from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  generateScreeningItems,
  proofPromptViolation,
  stemViolation,
  SCREENING_MODEL,
} from '../lib/screeningItems';

// Same minimal .env.local loader the verify scripts use — shell vars win.
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvLocal();

const TOPIC = 'Founder verification run, 2026-09-15';

const OBJECTIVES = [
  'How did the 2024 SAP migration affect order-to-cash cycle time?',
  'Why did Tier 2 suppliers in Southeast Asia lose share in 2023-2025?',
  'What drove churn in mid-market SaaS security tooling last year?',
  'How do regional grocers actually evaluate private-label vendors?',
  'What changed in poultry cold-chain logistics costs post-2022?',
].map((text, i) => ({ id: `obj-${i + 1}`, text }));

async function main(): Promise<void> {
  const apiKey = process.env.ANTRHOPICKEYREAL;
  if (!apiKey) {
    console.error('ANTRHOPICKEYREAL is not set. Export it or add it to .env.local, then re-run.');
    process.exit(2);
  }

  // The raw SDK call first, so a transport or parameter error shows up as the
  // SDK reports it rather than as a generation "fallback".
  const client = new Anthropic({ apiKey });
  let calls = 0;
  const createMessage = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    calls++;
    const started = Date.now();
    try {
      const resp = await client.messages.create(params);
      console.log(`call ${calls}: ${resp.model} stop_reason=${resp.stop_reason} `
        + `in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ${Date.now() - started}ms`);
      return resp;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(`call ${calls}: API error ${err.status ?? 'unknown'}: ${err.message}`);
      } else {
        console.error(`call ${calls}: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
  };

  console.log(`model: ${SCREENING_MODEL}, sdk: @anthropic-ai/sdk ${sdkVersion()}, objectives: ${OBJECTIVES.length}`);

  const result = await generateScreeningItems({ topic: TOPIC, objectives: OBJECTIVES }, { createMessage });

  console.log(`\nsource: ${result.source}${result.reason ? ` (reason: ${result.reason})` : ''}, model calls: ${calls}\n`);
  result.items.forEach((item, i) => {
    console.log(`${i + 1}. objective:    ${OBJECTIVES[i]?.text ?? ''}`);
    console.log(`   stem:         ${item.stem}`);
    console.log(`   proof prompt: ${item.proofPrompt}`);
    console.log(`   source:       ${item.source}`
      + (item.source === 'fallback' && item.modelProofPrompt
        ? ` (model wrote: "${item.modelProofPrompt}" → ${proofPromptViolation(item.modelProofPrompt) ?? stemViolation(item.modelStem ?? '') ?? 'refused'})`
        : ''));
    console.log('');
  });
}

function sdkVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

main().catch(err => {
  console.error('try-screening-items failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
