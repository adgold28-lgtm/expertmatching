// Parse inbound expert reply emails using GPT-4o-mini.
// Classifies intent and extracts structured data.
//
// Input is sanitized before LLM call (max 2000 chars, control chars stripped).
// Never logs email content.

import { openai } from './openai';

export type ReplyIntent = 'interested' | 'declined' | 'counter_rate' | 'conflict' | 'opt_out' | 'unclear';

export interface ParsedReply {
  intent:        ReplyIntent;
  counterRate?:  number;      // parsed $/hr if they propose a different rate
  conflictNote?: string;      // brief description of the conflict if flagged
  rawText:       string;      // sanitized input (never logged)
}

// ─── Sanitize ─────────────────────────────────────────────────────────────────

function sanitizeForPrompt(value: string, max: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max).trim();
}

// ─── Opt-out detection (compliance) ────────────────────────────────────────────
// Deterministic keyword match — runs BEFORE the LLM so an opt-out is always
// honored regardless of model behavior, latency, or availability (CAN-SPAM /
// TCPA "STOP" handling). Errs toward catching opt-outs: over-suppression is the
// safe direction. The matched address is added to the #16 suppression list by
// the caller (app/api/inbound-email/route.ts).
const OPT_OUT_PATTERNS: RegExp[] = [
  /^\s*(stop|unsubscribe|remove|cancel|end|quit)[.!]*\s*$/i, // whole reply is a single keyword (SMS-style)
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\b(remove|take)\s+me\s+(off|from)\b/i,
  /\bdo\s*n['’]?t\s+(contact|email|message)\b/i,
  /\bdo\s+not\s+(contact|email|message)\b/i,
  /\b(please\s+)?stop\s+(email|contact|messag|sending|reaching)/i,
];

export function detectOptOut(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(normalized));
}

// ─── Parse ────────────────────────────────────────────────────────────────────

export async function parseReply(emailBody: string): Promise<ParsedReply> {
  const sanitized = sanitizeForPrompt(emailBody, 2000);

  // Compliance short-circuit: honor opt-out requests deterministically,
  // without (and before) any LLM call.
  if (detectOptOut(sanitized)) {
    return { intent: 'opt_out', rawText: sanitized };
  }

  const systemPrompt = `You are classifying expert reply emails for a research firm.

Classify the intent and extract structured data. Respond with valid JSON only — no explanation, no markdown.

JSON schema:
{
  "intent": "interested" | "declined" | "counter_rate" | "conflict" | "unclear",
  "counterRate": number | null,   // $/hr if they propose a different rate, else null
  "conflictNote": string | null   // brief conflict description (under 200 chars) if intent=conflict, else null
}

Intent definitions:
- interested: they want to proceed, no issues raised
- declined: they don't want to participate
- counter_rate: they propose a different hourly rate
- conflict: they mention a conflict of interest, NDA, employer restriction, or similar
- unclear: reply is ambiguous, off-topic, or out-of-office`;

  const userPrompt = `Classify this reply email:\n\n${sanitized}`;

  let raw = '';
  try {
    const response = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      max_tokens:  200,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    });

    raw = (response.choices[0].message.content ?? '').trim();

    // Strip markdown code fences if present
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
    const jsonStr   = jsonMatch ? (jsonMatch[1] ?? raw) : raw;
    const parsed    = JSON.parse(jsonStr) as {
      intent:       string;
      counterRate:  number | null;
      conflictNote: string | null;
    };

    const intent = validateIntent(parsed.intent);

    return {
      intent,
      counterRate:  (intent === 'counter_rate' && typeof parsed.counterRate === 'number' && parsed.counterRate > 0)
        ? Math.round(parsed.counterRate)
        : undefined,
      conflictNote: (intent === 'conflict' && typeof parsed.conflictNote === 'string')
        ? sanitizeForPrompt(parsed.conflictNote, 200)
        : undefined,
      rawText: sanitized,
    };
  } catch (err) {
    console.error('[replyDetection] parse error:', err instanceof Error ? err.message.slice(0, 80) : 'unknown');
    return { intent: 'unclear', rawText: sanitized };
  }
}

function validateIntent(s: string): ReplyIntent {
  const valid: ReplyIntent[] = ['interested', 'declined', 'counter_rate', 'conflict', 'opt_out', 'unclear'];
  return valid.includes(s as ReplyIntent) ? (s as ReplyIntent) : 'unclear';
}
