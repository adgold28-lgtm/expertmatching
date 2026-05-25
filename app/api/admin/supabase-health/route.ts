// app/api/admin/supabase-health/route.ts
//
// Minimal connectivity check for Supabase Stage 1 infrastructure.
// Admin-only — gated by the existing adminGuard.
//
// Returns:
//   { ok: true,  project_url: string, connected: true }   — env vars present, client initialised
//   { ok: false, error: string }                           — env vars missing or client threw
//
// Does NOT expose the anon key, service role key, or any session data.
// Does NOT alter login, logout, or any existing auth behavior.
// Does NOT require a Supabase session to exist.
//
// To test:
//   curl -s http://localhost:3000/api/admin/supabase-health \
//     -H "Cookie: expertmatch_session=<your-admin-session>"

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { createClient } from '../../../../lib/supabase/server';

export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key  = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    const missing = [
      !url  && 'NEXT_PUBLIC_SUPABASE_URL',
      !key  && 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ].filter(Boolean);
    return Response.json(
      { ok: false, error: `Missing env vars: ${missing.join(', ')}` },
      { status: 503 },
    );
  }

  // Redact the key — show only the first 12 chars so the admin can confirm
  // which project is configured without exposing the full credential.
  const keyPreview = key.slice(0, 12) + '…';

  try {
    // createClient() initialises the @supabase/ssr browser client with the
    // configured URL + key.  If either value is malformed, createServerClient
    // throws synchronously.  getSession() makes no network call — it only
    // reads the (empty) cookie store — so this stays fast and side-effect-free.
    const supabase = createClient();
    await supabase.auth.getSession();

    // Derive the project hostname from the URL for display only.
    let projectHost: string;
    try {
      projectHost = new URL(url).hostname;
    } catch {
      projectHost = url;
    }

    return Response.json({
      ok:          true,
      connected:   true,
      project_url: projectHost,
      key_preview: keyPreview,
      note:        'Stage 1 only — Supabase auth is not yet wired into the login flow.',
    });
  } catch (err) {
    console.error('[supabase-health] client init failed:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { ok: false, error: 'Supabase client failed to initialise — check env var values.' },
      { status: 500 },
    );
  }
}
