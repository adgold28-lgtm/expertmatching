'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProjectSummary, ExpertStatus } from '../../types';
import { summaryStage, type SummaryStage } from '../../lib/expertPipeline';

// -----------------------------------------------------------------------------
// /app — the client's project dashboard: list of projects (GET /api/projects),
// trial/welcome banners driven by /api/auth/me's `account` field, and the
// "New Project" modal (POST /api/projects) that decides whether the project
// starts in walkthrough or live mode. All authorization is server-side —
// /api/projects returns only the caller's own organization's projects; this
// page renders whatever it is given and never filters by role itself. Team
// visibility (`canManageTeam`) is copy-only, mirroring the same pattern used
// in app/settings/page.tsx and app/settings/team/page.tsx: the link is hidden
// for members who cannot use it, but /api/org/members is what actually
// enforces the admin/champion check.
// -----------------------------------------------------------------------------

/**
 * ProjectSummary does not carry per-status counts yet — lib/projectStore only
 * derives `expertCount` and `shortlistedCount`, and `shortlisted` is a status
 * the Brief → Matches → Conversations flow no longer writes. The optional
 * `stageCounts` below is what the store needs to add; until it does, every read
 * is guarded and a project with experts reads as "Matches".
 */
type ProjectSummaryWithStages = ProjectSummary & {
  stageCounts?: Partial<Record<ExpertStatus, number>>;
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STAGE_COLORS: Record<SummaryStage, { bg: string; text: string }> = {
  Brief:              { bg: '#F0F2F5',                text: '#6B7C8D' },
  Matches:            { bg: '#EBF0F7',                text: '#0B1F3B' },
  'In conversation':  { bg: 'rgba(198,167,94,0.15)',  text: '#8B6914' },
  Scheduled:          { bg: '#EDFAF3',                text: '#1A7A4A' },
  Completed:          { bg: '#EDFAF3',                text: '#1A7A4A' },
};

// The client's three real steps (docs/MATCHY_SPEC.md). Outreach / Screen /
// Deliver are staff-only inside a project and never appear here.
const STEPS = ['Brief', 'Matches', 'Conversations'] as const;

/** How many of the three steps are behind this project, 1–3. */
const STAGE_STEP: Record<SummaryStage, number> = {
  Brief:             1,
  Matches:           2,
  'In conversation': 3,
  Scheduled:         3,
  Completed:         3,
};

/**
 * Error codes from POST /api/projects, written out. Anything unmapped falls
 * back to the generic line — the raw code is never rendered.
 * `onboarding_incomplete` is handled separately: it also routes to onboarding.
 */
const CREATE_ERROR_LINES: Record<string, string> = {
  onboarding_incomplete:    'Finish setting up your account first.',
  failed_to_create_project: "We couldn't create the project. Try again.",
  invalid_walkthrough:      "Couldn't read that setting. Try again.",
};

// ─── Walkthrough vs live ──────────────────────────────────────────────────────
//
// The one decision a new project starts with. Walkthrough is preselected, and
// it is what an absent flag means server-side too (lib/walkthrough.ts), so a
// request that never reaches the API still lands on the safe state.

type ProjectMode = 'walkthrough' | 'live';

const PROJECT_MODES: Array<{ id: ProjectMode; label: string; blurb: string }> = [
  {
    id:    'walkthrough',
    label: 'Walkthrough',
    blurb: 'Click through everything. No email reaches an expert.',
  },
  {
    id:    'live',
    label: 'Live',
    blurb: 'Matchy emails real experts when you bookmark them.',
  },
];

// ─── Main Page ─────────────────────────────────────────────────────────────────

interface CurrentUser {
  email:      string;
  role:       'admin' | 'user';
  firmDomain: string;
  orgRole?:   'org_admin' | 'org_member';
}

export default function AppPage() {
  const router = useRouter();

  const [projects,        setProjects]        = useState<ProjectSummaryWithStages[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  // A failed list is an ERROR, not an empty account — "Start your first project"
  // on a 500 would send a tester to recreate work that is still there.
  const [projectsError,   setProjectsError]   = useState('');
  const [listAttempt,     setListAttempt]     = useState(0);
  // lib/entitlements.ts: 'trial' until the firm adds a card.
  const [accountKind,     setAccountKind]     = useState<'trial' | 'customer' | null>(null);
  const [currentUser,     setCurrentUser]     = useState<CurrentUser | null>(null);
  const [canManageTeam,   setCanManageTeam]   = useState(false);
  const [showWelcome,     setShowWelcome]     = useState(false);

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [projectName,         setProjectName]         = useState('');
  // Walkthrough is the default and the safe one: nothing reaches an expert
  // until the owner deliberately switches the project live (lib/walkthrough.ts).
  const [projectMode,         setProjectMode]         = useState<ProjectMode>('walkthrough');
  const [creating,            setCreating]            = useState(false);
  const [createError,         setCreateError]         = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('welcome') === '1') {
        setShowWelcome(true);
        window.history.replaceState({}, '', '/app');
      }
    }
  }, []);

  useEffect(() => {
    setProjectsLoading(true);
    setProjectsError('');
    fetch('/api/projects')
      .then(async r => {
        const d = await r.json().catch(() => ({})) as { projects?: ProjectSummaryWithStages[]; error?: string };
        if (!r.ok) throw new Error(d.error ?? `http_${r.status}`);
        setProjects(d.projects ?? []);
      })
      .catch(() => setProjectsError("We couldn't load your projects. They are still there — try again."))
      .finally(() => setProjectsLoading(false));
  }, [listAttempt]);

  useEffect(() => {

    // /api/auth/me carries orgRole; read it defensively and confirm with the
    // membership endpoint (which is authoritative for legacy sessions).
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: {
        email?:      string;
        role?:       'admin' | 'user';
        firmDomain?: string;
        orgRole?:    'org_admin' | 'org_member';
        account?:    { kind: 'trial' | 'customer'; canGoLive: boolean };
      }) => {
        if (!d.email) return;
        if (d.account?.kind) setAccountKind(d.account.kind);
        setCurrentUser({
          email:      d.email,
          role:       d.role ?? 'user',
          firmDomain: d.firmDomain ?? '',
          orgRole:    d.orgRole,
        });
        if (d.role === 'admin' || d.orgRole === 'org_admin') setCanManageTeam(true);
      })
      .catch(() => {});

    fetch('/api/org/membership')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { canManageTeam?: boolean } | null) => {
        if (d?.canManageTeam) setCanManageTeam(true);
      })
      .catch(() => {});
  }, []);

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  function openNewProjectModal() {
    setProjectName('');
    setProjectMode('walkthrough');
    setCreateError('');
    setShowNewProjectModal(true);
  }

  function closeNewProjectModal() {
    setShowNewProjectModal(false);
    setProjectName('');
    setProjectMode('walkthrough');
    setCreateError('');
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/projects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:        projectName.trim() || undefined,
          walkthrough: projectMode === 'walkthrough',
        }),
      });
      const data = await res.json() as { project?: { id: string }; error?: string };
      if (!res.ok || !data.project) {
        // A raw error code is never shown — every path ends in a sentence.
        if (data.error === 'onboarding_incomplete') {
          setCreateError(CREATE_ERROR_LINES.onboarding_incomplete);
          router.push('/onboarding');
          return;
        }
        setCreateError(CREATE_ERROR_LINES[data.error ?? ''] ?? 'Something went wrong. Try again.');
        return;
      }
      router.push(`/projects/${data.project.id}`);
    } catch {
      setCreateError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  const sorted       = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  const totalExperts = projects.reduce((sum, p) => sum + p.expertCount, 0);
  // Only claimable once the summaries carry per-status counts — a hardcoded 0
  // would read as "no calls" rather than "we don't know".
  const completedKnown  = projects.some(p => p.stageCounts !== undefined);
  const callsCompleted  = projects.reduce((sum, p) => sum + (p.stageCounts?.completed ?? 0), 0);
  const stats: Array<{ label: string; value: number }> = [
    { label: 'Total Projects',  value: projects.length },
    { label: 'Experts Sourced', value: totalExperts    },
    ...(completedKnown ? [{ label: 'Calls Completed', value: callsCompleted }] : []),
  ];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F7F5' }}>

      {/* ── Welcome banner ── */}
      {showWelcome && (
        <div
          className="flex items-center justify-between px-6 py-3 text-[11px] font-medium"
          style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.06em' }}
        >
          <span>You&apos;re all set. Create your first project to get started.</span>
          <button
            onClick={() => setShowWelcome(false)}
            className="ml-4 opacity-60 hover:opacity-100 transition-opacity text-base leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Trial banner ── */}
      {accountKind === 'trial' && (
        <div
          className="px-6 py-2.5 text-[11px] flex items-center justify-between gap-4 flex-wrap"
          style={{ background: '#0B1F3B', color: '#F7F7F5', letterSpacing: '0.04em' }}
        >
          <span>
            <span className="uppercase font-semibold mr-2" style={{ color: '#C6A75E', letterSpacing: '0.14em' }}>Trial</span>
            Brief, source and bookmark freely. Nothing reaches a real expert until your firm adds a card.
          </span>
          <Link href="/settings" className="underline underline-offset-2 hover:opacity-80" style={{ color: '#C6A75E' }}>
            Activate in Settings →
          </Link>
        </div>
      )}

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-3">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end">
            <button
              onClick={openNewProjectModal}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors"
              style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
            >
              New Project
            </button>
            {canManageTeam && (
              <Link
                href="/settings/team"
                className="text-[10px] uppercase font-medium px-4 py-2 transition-colors border hover:text-gold"
                style={{ color: 'rgba(198,167,94,0.6)', borderColor: 'rgba(198,167,94,0.25)', letterSpacing: '0.14em' }}
              >
                Team
              </Link>
            )}
            <Link
              href="/settings"
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors border hover:text-gold"
              style={{ color: 'rgba(198,167,94,0.6)', borderColor: 'rgba(198,167,94,0.25)', letterSpacing: '0.14em' }}
            >
              Settings
            </Link>
            <button
              onClick={handleSignOut}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors border"
              style={{ color: 'rgba(198,167,94,0.6)', borderColor: 'rgba(198,167,94,0.25)', letterSpacing: '0.14em' }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* ── Stats bar ── */}
      {!projectsLoading && projects.length > 0 && (
        <div style={{ background: '#fff', borderBottom: '1px solid #E8ECF0' }}>
          <div className="max-w-6xl mx-auto px-6 sm:px-10">
            <div className="flex divide-x divide-gray-100">
              {stats.map(stat => (
                <div key={stat.label} className="py-4 pr-8 first:pl-0 pl-8">
                  <p
                    className="text-[22px] font-semibold leading-none"
                    style={{ color: '#0B1F3B', fontFamily: 'var(--font-display)' }}
                  >
                    {stat.value}
                  </p>
                  <p
                    className="text-[10px] uppercase tracking-widest mt-1"
                    style={{ color: '#9AA5B4', letterSpacing: '0.14em' }}
                  >
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Project cards ── */}
      <div className="flex-1">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8">

          {/* Section label */}
          <p
            className="text-[10px] uppercase tracking-widest font-medium mb-5"
            style={{ color: '#9AA5B4', letterSpacing: '0.2em' }}
          >
            Projects
          </p>

          {projectsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-white rounded-sm p-5 shadow-sm border border-gray-100 space-y-3">
                  <div className="skeleton h-4 w-2/3 rounded" />
                  <div className="skeleton h-3 w-1/3 rounded" />
                  <div className="skeleton h-2 w-full rounded mt-4" />
                </div>
              ))}
            </div>
          ) : projectsError ? (
            <div className="bg-white border border-red-200 p-6 max-w-lg">
              <p className="text-sm text-red-700 mb-3">{projectsError}</p>
              <button
                type="button"
                onClick={() => setListAttempt(n => n + 1)}
                className="text-[10px] uppercase tracking-widest px-4 py-2 border border-navy text-navy hover:bg-navy hover:text-cream transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                Try again
              </button>
            </div>
          ) : sorted.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sorted.map(p => {
                const stageLabel = summaryStage(p);
                const step       = STAGE_STEP[stageLabel];
                const pill       = STAGE_COLORS[stageLabel];
                const projectName = p.name || (p.researchQuestion ? p.researchQuestion.slice(0, 60) : 'Untitled Project');

                return (
                  <div
                    key={p.id}
                    className="bg-white rounded-sm shadow-sm border border-gray-100 flex flex-col hover:shadow-md transition-shadow"
                  >
                    <div className="p-5 flex-1 space-y-3">
                      {/* Status pill */}
                      <div className="flex items-center justify-between">
                        <span
                          className="text-[9px] uppercase tracking-widest font-semibold px-2 py-0.5"
                          style={{ background: pill.bg, color: pill.text, letterSpacing: '0.12em' }}
                        >
                          {stageLabel}
                        </span>
                        <span className="text-[10px]" style={{ color: '#9AA5B4' }}>
                          {formatDate(p.createdAt)}
                        </span>
                      </div>

                      {/* Project name */}
                      <p
                        className="font-semibold leading-snug line-clamp-2"
                        style={{ color: '#0B1F3B', fontSize: '14px' }}
                      >
                        {projectName}
                      </p>

                      {/* Expert count */}
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 shrink-0" style={{ color: '#9AA5B4' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                        </svg>
                        <span className="text-[11px]" style={{ color: '#9AA5B4' }}>
                          {p.expertCount} expert{p.expertCount !== 1 ? 's' : ''}
                        </span>
                      </div>

                      {/* Progress bar — Brief · Matches · Conversations */}
                      <div className="flex gap-1 pt-1">
                        {STEPS.map((s, i) => (
                          <div
                            key={s}
                            className="flex-1 h-1 rounded-full transition-colors"
                            style={{ background: i < step ? '#0B1F3B' : '#E8ECF0' }}
                            title={s}
                          />
                        ))}
                      </div>
                      <div className="flex justify-between">
                        {STEPS.map((s, i) => (
                          <span
                            key={s}
                            className={`text-[8px] uppercase ${i === step - 1 ? 'font-semibold' : ''}`}
                            style={{
                              color: i < step ? '#0B1F3B' : '#C4CDD6',
                              letterSpacing: '0.06em',
                              width: `${100 / STEPS.length}%`,
                              textAlign: i === 0 ? 'left' : i === STEPS.length - 1 ? 'right' : 'center',
                            }}
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Card footer — Open button */}
                    <div className="px-5 pb-5">
                      <Link
                        href={`/projects/${p.id}`}
                        className="block w-full text-center text-[10px] uppercase tracking-widest font-medium py-2 transition-colors"
                        style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
                      >
                        Open →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── Empty state ── */
            <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
              <div
                className="w-12 h-12 flex items-center justify-center mb-6 rounded-full"
                style={{ background: 'rgba(198,167,94,0.12)' }}
              >
                <svg className="w-6 h-6" style={{ color: '#C6A75E' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 0z" />
                </svg>
              </div>
              <p
                className="font-semibold mb-2"
                style={{ color: '#0B1F3B', fontSize: '16px' }}
              >
                Start your first project
              </p>
              <p
                className="text-sm mb-8 max-w-sm leading-relaxed"
                style={{ color: '#9AA5B4', fontWeight: 300 }}
              >
                Describe the business problem and we&apos;ll find the right experts.
              </p>
              <button
                onClick={openNewProjectModal}
                className="text-[10px] uppercase font-medium px-6 py-3 transition-colors"
                style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
              >
                New Project
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── New Project Modal ── */}
      {showNewProjectModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(11,31,59,0.55)', backdropFilter: 'blur(2px)' }}
          onClick={e => { if (e.target === e.currentTarget) closeNewProjectModal(); }}
        >
          <div
            className="bg-cream border border-frame w-full max-w-md shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="New Project"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-frame">
              <p className="text-[11px] uppercase tracking-widest text-navy font-medium" style={{ letterSpacing: '0.18em' }}>
                New Project
              </p>
              <button
                onClick={closeNewProjectModal}
                className="text-muted hover:text-navy transition-colors p-1"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <form onSubmit={handleCreateProject} className="px-6 py-5 space-y-5">
              <div>
                <label
                  htmlFor="project-name"
                  className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                  style={{ letterSpacing: '0.18em' }}
                >
                  Project name
                </label>
                <input
                  id="project-name"
                  type="text"
                  value={projectName}
                  onChange={e => { setProjectName(e.target.value); setCreateError(''); }}
                  placeholder="e.g. Cold Chain Logistics — Southeast Entry"
                  maxLength={200}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                  style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                />
              </div>

              {/* ── Walkthrough or live ── */}
              <fieldset className="space-y-2" disabled={creating}>
                <legend
                  className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                  style={{ letterSpacing: '0.18em' }}
                >
                  How this project starts
                </legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PROJECT_MODES.map(mode => {
                    const selected = projectMode === mode.id;
                    return (
                      <label
                        key={mode.id}
                        className={`flex gap-2 items-start border px-3 py-2.5 cursor-pointer transition-colors ${
                          creating ? 'opacity-50 cursor-not-allowed' : ''
                        } ${selected ? 'border-navy bg-navy/5' : 'border-frame hover:border-navy/40'}`}
                      >
                        <input
                          type="radio"
                          name="project-mode"
                          value={mode.id}
                          checked={selected}
                          onChange={() => { setProjectMode(mode.id); setCreateError(''); }}
                          disabled={creating}
                          className="mt-[3px] shrink-0 accent-navy"
                        />
                        <span className="min-w-0">
                          <span
                            className={`block text-[10px] uppercase tracking-widest font-semibold ${selected ? 'text-navy' : 'text-muted'}`}
                            style={{ letterSpacing: '0.14em' }}
                          >
                            {mode.label}
                          </span>
                          <span className="block text-[11px] text-muted leading-relaxed mt-0.5">
                            {mode.blurb}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {projectMode === 'live' && (
                  <p className="text-[11px] text-amber-700 leading-relaxed">
                    You can switch back at any time in the project settings.
                  </p>
                )}
              </fieldset>

              {createError && (
                <p className="text-xs text-red-600">{createError}</p>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={closeNewProjectModal}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2.5 transition-colors"
                  style={{ letterSpacing: '0.12em' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
                >
                  {creating ? 'Creating…' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
