'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProjectSummary, ExpertStatus } from '../../types';
import { summaryStage, type SummaryStage } from '../../lib/expertPipeline';

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
};

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
  const [currentUser,     setCurrentUser]     = useState<CurrentUser | null>(null);
  const [canManageTeam,   setCanManageTeam]   = useState(false);
  const [showWelcome,     setShowWelcome]     = useState(false);

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [projectName,         setProjectName]         = useState('');
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
    fetch('/api/projects')
      .then(r => r.json())
      .then((d: { projects?: ProjectSummaryWithStages[] }) => {
        setProjects(d.projects ?? []);
        setProjectsLoading(false);
      })
      .catch(() => setProjectsLoading(false));

    // /api/auth/me carries orgRole; read it defensively and confirm with the
    // membership endpoint (which is authoritative for legacy sessions).
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: {
        email?:      string;
        role?:       'admin' | 'user';
        firmDomain?: string;
        orgRole?:    'org_admin' | 'org_member';
      }) => {
        if (!d.email) return;
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
    setCreateError('');
    setShowNewProjectModal(true);
  }

  function closeNewProjectModal() {
    setShowNewProjectModal(false);
    setProjectName('');
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
        body:    JSON.stringify({ name: projectName.trim() || undefined }),
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
