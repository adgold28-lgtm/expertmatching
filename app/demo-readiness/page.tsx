'use client';

// Demo readiness checklist — private admin page.
//
// Security model:
// - NEVER displays env var values — only checks boolean presence (!!process.env.X).
// - This page must never be indexed; add to robots.txt before public launch.
// - TODO: Gate behind admin auth before public launch.
//
// This is a client-side page that checks server-side env via an API endpoint,
// because process.env is not accessible directly in client components.

import { useEffect, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckResult {
  key: string;
  present: boolean;
}

interface ChecklistGroup {
  label: string;
  checks: CheckResult[];
}

// ─── Readiness check API (server-side env inspection) ────────────────────────

// This page fetches /api/demo-readiness which returns only boolean presence
// flags — never actual values. See app/api/demo-readiness/route.ts.

// ─── Sub-components ───────────────────────────────────────────────────────────

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-frame last:border-0">
      <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
        check.present ? 'bg-status-success/15 text-status-success' : 'bg-red-50 text-red-500'
      }`}>
        {check.present ? (
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </div>
      <code className="text-[11px] font-mono text-ink flex-1">{check.key}</code>
      <span className={`text-[10px] uppercase tracking-wider font-medium ${
        check.present ? 'text-status-success' : 'text-red-500'
      }`}>
        {check.present ? 'Set' : 'Missing'}
      </span>
    </div>
  );
}

function GroupSection({ group, allPresent }: { group: ChecklistGroup; allPresent: boolean }) {
  return (
    <section className="border border-frame bg-white">
      <div className={`px-5 py-3 border-b border-frame flex items-center justify-between ${
        allPresent ? 'bg-status-success/5' : 'bg-red-50/60'
      }`}>
        <p className="text-[11px] uppercase tracking-widest font-semibold text-navy" style={{ letterSpacing: '0.14em' }}>
          {group.label}
        </p>
        <span className={`text-[10px] uppercase tracking-wider font-medium ${
          allPresent ? 'text-status-success' : 'text-red-500'
        }`}>
          {allPresent ? '✓ Ready' : `${group.checks.filter(c => !c.present).length} missing`}
        </span>
      </div>
      <div className="px-5">
        {group.checks.map(c => <CheckRow key={c.key} check={c} />)}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DemoReadinessPage() {
  const [groups,  setGroups]  = useState<ChecklistGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch('/api/demo-readiness');
        const data = await res.json() as { groups?: ChecklistGroup[]; error?: string };
        if (!res.ok || !data.groups) {
          setError(data.error ?? 'Failed to load readiness data.');
          return;
        }
        setGroups(data.groups);
      } catch {
        setError('Failed to load readiness data.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalChecks  = groups.reduce((n, g) => n + g.checks.length, 0);
  const totalPresent = groups.reduce((n, g) => n + g.checks.filter(c => c.present).length, 0);
  const allReady     = totalChecks > 0 && totalPresent === totalChecks;

  return (
    <div className="min-h-screen" style={{ background: '#F7F9FC' }}>

      {/* Header */}
      <header className="bg-navy border-b-2 border-gold">
        <div className="max-w-2xl mx-auto px-6 py-5">
          <p className="text-[10px] uppercase tracking-widest text-gold/50 mb-1" style={{ letterSpacing: '0.18em' }}>
            ExpertMatch · Admin
          </p>
          <h1 className="font-display text-cream font-semibold text-xl">Demo Readiness</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-6">

        {loading && (
          <p className="text-xs uppercase tracking-widest text-muted animate-pulse text-center py-12">
            Checking environment…
          </p>
        )}

        {error && (
          <div className="border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Summary banner */}
            <div className={`border px-5 py-4 flex items-center justify-between ${
              allReady ? 'border-status-success/30 bg-status-success/5' : 'border-amber-200 bg-amber-50'
            }`}>
              <div>
                <p className={`font-display font-semibold text-lg leading-tight ${
                  allReady ? 'text-status-success' : 'text-amber-800'
                }`}>
                  {allReady ? '✓ All systems go' : `${totalChecks - totalPresent} item${totalChecks - totalPresent !== 1 ? 's' : ''} need attention`}
                </p>
                <p className="text-xs text-muted mt-0.5">
                  {totalPresent} / {totalChecks} environment variables set
                </p>
              </div>
              <div className="text-right">
                <div className={`font-display text-3xl font-semibold leading-none ${
                  allReady ? 'text-status-success' : 'text-amber-700'
                }`}>
                  {totalChecks > 0 ? Math.round((totalPresent / totalChecks) * 100) : 0}%
                </div>
              </div>
            </div>

            {/* Checklist groups */}
            {groups.map(group => (
              <GroupSection
                key={group.label}
                group={group}
                allPresent={group.checks.every(c => c.present)}
              />
            ))}

            {/* Manual test checklist */}
            <section className="border border-frame bg-white">
              <div className="px-5 py-3 border-b border-frame bg-navy/5">
                <p className="text-[11px] uppercase tracking-widest font-semibold text-navy" style={{ letterSpacing: '0.14em' }}>
                  Manual Test Checklist
                </p>
              </div>
              <div className="px-5 py-4 space-y-2">
                {[
                  'Create a new project from the landing page',
                  'Run expert sourcing (Source tab) — verify results appear',
                  'Shortlist 2+ experts, reject 1 with a reason',
                  'Re-run sourcing — verify rejection feedback affects scoring',
                  'Generate vetting questions for a shortlisted expert',
                  'Open ScreeningCard — fill in ratings, set status to client_ready',
                  'Open Client View (↗ in header) — verify no internal notes visible',
                  'Export Brief → Copy Markdown — verify evidenceItems appear',
                  'Export Brief → Download .md — verify file downloads',
                  'Contact enrichment — click "Find Email", confirm email before spending credit',
                  'Generate outreach draft — verify it opens',
                  'Navigate to /demo-readiness — this page renders without errors',
                ].map((item, i) => (
                  <label key={i} className="flex items-start gap-3 cursor-pointer group">
                    <input type="checkbox" className="mt-0.5 shrink-0 accent-navy" />
                    <span className="text-xs text-ink leading-snug group-hover:text-navy transition-colors">
                      {item}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <p className="text-[10px] text-muted/50 text-center">
              Values are never displayed — only presence is checked. This page is for admin use only.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
