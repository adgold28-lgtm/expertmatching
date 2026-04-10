import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });

export async function POST(request: NextRequest) {
  try {
    const { expert, query } = await request.json();

    const prompt = `Write a cold outreach message to ${expert.name}, ${expert.title} at ${expert.company}.

Context:
- The researcher's question: "${query}"
- Why this expert is relevant: "${expert.justification}"

Requirements:
- 3-4 short paragraphs max
- Mention their specific role and company naturally
- Ask for a 20-30 minute introductory call
- Be warm, respectful, and direct — not salesy
- Reference the specific topic/question naturally
- Sound human, not like a template
- Subject line on first line formatted as: Subject: [subject here]
- Then a blank line, then the message body starting with "Hi [First Name],"

Return only the message text with subject line. No extra commentary.`;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text in response');
    }

    return Response.json({ message: textBlock.text.trim() });
  } catch (err) {
    console.error('generate-outreach error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
