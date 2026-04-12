import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });

interface SerpResult {
  title: string;
  link: string;
  snippet: string;
  displayed_link: string;
}

interface CategoryResults {
  category: string;
  query: string;
  results: SerpResult[];
}

async function runSerpQuery(query: string): Promise<SerpResult[]> {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGBEE_KEY environment variable not set.');
  }

  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}&nb_results=5`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`ScrapingBee returned ${res.status} for query: ${query}`);
      return [];
    }
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.organic_results || []).map((r: any) => ({
      title: r.title || '',
      link: r.url || r.link || '',
      snippet: r.description || r.snippet || '',
      displayed_link: r.displayed_url || r.displayed_link || '',
    }));
  } catch (err) {
    console.error(`ScrapingBee fetch error for query "${query}":`, err);
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.SCRAPINGBEE_KEY) {
      return Response.json(
        { error: 'SCRAPINGBEE_KEY environment variable not set.' },
        { status: 400 }
      );
    }

    const { query, geography, seniority } = await request.json();

    if (!query?.trim()) {
      return Response.json({ error: 'Query is required' }, { status: 400 });
    }

    const filters = [
      geography && geography !== 'any' ? `Geography: ${geography}` : null,
      seniority && seniority !== 'any' ? `Seniority: ${seniority}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    // ── Step 1: Generate search queries via Claude ──────────────────────────
    const queryGenPrompt = `You are a research sourcing expert. Generate exactly 6 targeted web search queries to find REAL, verifiable people related to the following business question.

Business Question: "${query.trim()}"
${filters ? `Filters:\n${filters}` : ''}

Generate 2 queries per category:
1. Operators (people actively working in the field — directors, VPs, managers, founders)
2. Advisors (consultants, PE/VC investors, analysts, ex-executives turned advisors)
3. Outsiders (mix of: Government/Regulatory, Large Enterprise procurement/strategy, Small Business/independent)

Queries should target LinkedIn profiles and professional sources. Use site: operators where helpful.

Return ONLY valid JSON in this exact structure (no markdown, no code fences):
{
  "queries": {
    "Operator": ["query1", "query2"],
    "Advisor": ["query1", "query2"],
    "Outsider": ["query1", "query2"]
  }
}`;

    const queryGenResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: queryGenPrompt }],
    });

    const queryGenTextBlock = queryGenResponse.content.find((b) => b.type === 'text');
    if (!queryGenTextBlock || queryGenTextBlock.type !== 'text') {
      throw new Error('No text in query generation response');
    }

    let queryGenText = queryGenTextBlock.text.trim();
    if (queryGenText.startsWith('```')) {
      queryGenText = queryGenText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const generatedQueries = JSON.parse(queryGenText);
    const operatorQueries: string[] = generatedQueries.queries?.Operator || [];
    const advisorQueries: string[] = generatedQueries.queries?.Advisor || [];
    const outsiderQueries: string[] = generatedQueries.queries?.Outsider || [];

    // ── Step 2: Run all 6 queries in parallel via SerpAPI ──────────────────
    const allQueryPairs: Array<{ category: string; query: string }> = [
      ...operatorQueries.map((q) => ({ category: 'Operator', query: q })),
      ...advisorQueries.map((q) => ({ category: 'Advisor', query: q })),
      ...outsiderQueries.map((q) => ({ category: 'Outsider', query: q })),
    ];

    const serpResults = await Promise.all(
      allQueryPairs.map(async ({ category, query: q }) => {
        const results = await runSerpQuery(q);
        return { category, query: q, results } as CategoryResults;
      })
    );

    // Group results by category
    const grouped: Record<string, CategoryResults[]> = { Operator: [], Advisor: [], Outsider: [] };
    for (const r of serpResults) {
      grouped[r.category].push(r);
    }

    // ── Step 3: Claude extracts real people from search results ────────────
    const formattedResults = Object.entries(grouped)
      .map(([cat, catResults]) => {
        const resultsText = catResults
          .map(
            (cr) =>
              `Query: "${cr.query}"\nResults:\n${cr.results
                .map((r, i) => `  ${i + 1}. Title: ${r.title}\n     URL: ${r.link}\n     Snippet: ${r.snippet}\n     Displayed Link: ${r.displayed_link}`)
                .join('\n')}`
          )
          .join('\n\n');
        return `=== ${cat.toUpperCase()} SEARCH RESULTS ===\n${resultsText}`;
      })
      .join('\n\n');

    const extractionPrompt = `You are an expert sourcing analyst. Below are real web search results. Extract REAL, verifiable people from these results.

Business Question: "${query.trim()}"
${filters ? `Filters:\n${filters}` : ''}

SEARCH RESULTS:
${formattedResults}

CRITICAL RULES:
- Only extract REAL people you can verify from the search results. If the search result does not clearly identify a specific person by name, skip it. Do not invent or hallucinate any information.
- Every expert MUST have a real source_url from the search results (the actual link field). Do NOT make up URLs.
- Use the person's name exactly as it appears in the search result title or snippet.
- If you cannot find a clearly identified real person in a category, return an empty array for that category — do NOT fabricate anyone.
- Names must be real human names (first + last name). Skip results that only identify organizations, job boards, or generic pages.
- source_label should be one of: "LinkedIn", "Company Website", "News Article", "Professional Directory", "Government Website"

Also generate a query_analysis object based on the business question.

Return ONLY valid JSON (no markdown, no code fences):
{
  "query_analysis": {
    "industry": "primary industry sector",
    "function": "primary business function",
    "key_topics": ["topic1", "topic2", "topic3"],
    "keywords": ["kw1", "kw2", "kw3", "kw4"],
    "confidence": "High",
    "confidence_reason": "one sentence explaining confidence level"
  },
  "experts": [
    {
      "id": "exp-1",
      "name": "Full Name",
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State",
      "category": "Operator",
      "outsider_subcategory": null,
      "justification": "Why this person is relevant to the question — based only on what the search result shows.",
      "relevance_score": 85,
      "source_url": "https://linkedin.com/in/...",
      "source_label": "LinkedIn"
    }
  ]
}

- For Outsiders, outsider_subcategory must be "Government", "Large Enterprise", or "Small Business"
- For Operators and Advisors, outsider_subcategory must be null
- Sort experts within each category by relevance_score descending
- Aim for 2-3 experts per category, but only include people you can actually verify from the results`;

    const extractionResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const extractionTextBlock = extractionResponse.content.find((b) => b.type === 'text');
    if (!extractionTextBlock || extractionTextBlock.type !== 'text') {
      throw new Error('No text in extraction response');
    }

    let extractionText = extractionTextBlock.text.trim();
    if (extractionText.startsWith('```')) {
      extractionText = extractionText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const extractedData = JSON.parse(extractionText);

    // ── Step 4: Validate and filter experts ────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validatedExperts = (extractedData.experts || []).filter((expert: any) => {
      // Must have a source_url
      if (!expert.source_url) return false;
      if (expert.source_url === '') return false;
      // source_url must start with http
      if (!expert.source_url.startsWith('http')) return false;
      // Name must look like a real person (contains a space)
      if (!expert.name || !expert.name.includes(' ')) return false;
      // Name must not be all caps (company-like)
      if (expert.name === expert.name.toUpperCase() && expert.name.length > 3) return false;
      return true;
    });

    // Compute insufficient_categories
    const categories = ['Operator', 'Advisor', 'Outsider'] as const;
    const insufficient_categories = categories
      .map((cat) => {
        const count = validatedExperts.filter((e: { category: string }) => e.category === cat).length;
        if (count < 2) {
          return { category: cat, found: count, required: 2 };
        }
        return null;
      })
      .filter(Boolean);

    return Response.json({
      query_analysis: extractedData.query_analysis,
      experts: validatedExperts,
      insufficient_categories,
    });
  } catch (err) {
    console.error('generate-experts error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
