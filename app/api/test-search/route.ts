import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const key = process.env.SCRAPINGBEE_KEY;
  if (!key) return Response.json({ error: 'SCRAPINGBEE_KEY not set' });

  const query = request.nextUrl.searchParams.get('q') || 'solar interconnection manager Texas site:linkedin.com/in';
  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${key}&q=${encodeURIComponent(query)}&nb_results=3`;

  try {
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return Response.json({ status: res.status, query, data });
  } catch (err) {
    return Response.json({ error: String(err) });
  }
}
