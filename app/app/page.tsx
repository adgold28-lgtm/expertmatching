'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProjectSummary } from '../../types';

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getProjectStage(p: ProjectSummary): { label: string; step: number } {
  if (p.expertCount === 0) return { label: 'Brief',    step: 1 };
  if (p.shortlistedCount === 0) return { label: 'Sourcing', step: 2 };
  return { label: 'Outreach', step: 3 };
}

const STAGE_COLORS: Record<string, { bg: string; text: string }> = {
  Brief:    { bg: '#F0F2F5',        text: '#6B7C8D' },
  Sourcing: { bg: '#EBF0F7',        text: '#0B1F3B' },
  Outreach: { bg: 'rgba(198,167,94,0.15)', text: '#8B6914' },
  Complete: { bg: '#EDFAF3',        text: '#1A7A4A' },
};

const STEPS = ['Brief', 'Source', 'Outreach', 'Screen', 'Deliver'];

// ─── Main Page ─────────────────────────────────────────────────────────────────

interface CurrentUser {
  email:      string;
  role:       'admin' | 'user';
  firmDomain: string;
}

export default function AppPage() {
  const router = useRouter();

  const [projects,        setProjects]        = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [currentUser,     setCurrentUser]     = useState<CurrentUser | null>(null);
  const [showWelcome,     setShowWelcome]     = useState(false);

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [briefProblem,        setBriefProblem]        = useState('');
  const [briefExpertType,     setBriefExpertType]     = useState('');
  const [outreachMode,        setOutreachMode]        = useState<'auto' | 'review'>('review');
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
      .then((d: { projects?: ProjectSummary[] }) => {
        setProjects(d.projects ?? []);
        setProjectsLoading(false);
      })
      .catch(() => setProjectsLoading(false));

    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { email?: string; role?: 'admin' | 'user'; firmDomain?: string }) => {
        if (d.email) setCurrentUser({ email: d.email, role: d.role ?? 'user', firmDomain: d.firmDomain ?? '' });
      })
      .catch(() => {});
  }, []);

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  function openNewProjectModal() {
    setBriefProblem('');
    setBriefExpertType('');
    setOutreachMode('review');
    setCreateError('');
    setShowNewProjectModal(true);
  }

  function closeNewProjectModal() {
    setShowNewProjectModal(false);
    setBriefProblem('');
    setBriefExpertType('');
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
          researchQuestion: briefProblem.trim() || undefined,
          expertType:       briefExpertType.trim() || undefined,
          industry:         '',
          function:         '',
          geography:        '',
          seniority:        '',
          outreachMode,
          experts:          [],
        }),
      });
      const data = await res.json() as { project?: { id: string }; error?: string };
      if (!res.ok || !data.project) {
        setCreateError(data.error ?? 'Failed to create project. Please try again.');
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
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={openNewProjectModal}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors"
              style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
            >
              New Project
            </button>
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
              {[
                { label: 'Total Projects',   value: projects.length },
                { label: 'Experts Sourced',  value: totalExperts    },
                { label: 'Calls Completed',  value: 0               },
              ].map(stat => (
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
                const { label: stageLabel, step } = getProjectStage(p);
                const pill = STAGE_COLORS[stageLabel] ?? STAGE_COLORS.Brief;
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

                      {/* Progress bar — 5 steps */}
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
                            className="text-[8px] uppercase"
                            style={{
                              color: i < step ? '#0B1F3B' : '#C4CDD6',
                              letterSpacing: '0.06em',
                              width: '20%',
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
                  htmlFor="brief-problem"
                  className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                  style={{ letterSpacing: '0.18em' }}
                >
                  What&apos;s the business problem?
                </label>
                <textarea
                  id="brief-problem"
                  value={briefProblem}
                  onChange={e => { setBriefProblem(e.target.value); setCreateError(''); }}
                  placeholder="e.g. We're evaluating entry into cold chain logistics in the Southeast"
                  rows={3}
                  maxLength={2000}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none"
                  style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                />
              </div>

              <div>
                <label
                  htmlFor="brief-expert-type"
                  className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                  style={{ letterSpacing: '0.18em' }}
                >
                  What type of person do you want to talk to?
                </label>
                <textarea
                  id="brief-expert-type"
                  value={briefExpertType}
                  onChange={e => { setBriefExpertType(e.target.value); setCreateError(''); }}
                  placeholder="e.g. Former VP of Operations at a regional 3PL or food distributor"
                  rows={3}
                  maxLength={2000}
                  className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none"
                  style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                />
              </div>

              {/* Outreach mode toggle */}
              <div>
                <p
                  className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2"
                  style={{ letterSpacing: '0.18em' }}
                >
                  Outreach mode
                </p>
                <div className="flex border border-frame overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOutreachMode('review')}
                    className="flex-1 px-4 py-2.5 text-[11px] font-medium transition-colors text-left"
                    style={{
                      background:  outreachMode === 'review' ? '#0B1F3B' : 'transparent',
                      color:       outreachMode === 'review' ? '#C6A75E' : '#6B7C8D',
                      borderRight: '1px solid #E2E8ED',
                      letterSpacing: '0.04em',
                    }}
                  >
                    <span className="block text-[10px] uppercase tracking-widest mb-0.5" style={{ letterSpacing: '0.14em' }}>
                      Review first
                    </span>
                    I review and approve before anything sends
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutreachMode('auto')}
                    className="flex-1 px-4 py-2.5 text-[11px] font-medium transition-colors text-left"
                    style={{
                      background:    outreachMode === 'auto' ? '#0B1F3B' : 'transparent',
                      color:         outreachMode === 'auto' ? '#C6A75E' : '#6B7C8D',
                      letterSpacing: '0.04em',
                    }}
                  >
                    <span className="block text-[10px] uppercase tracking-widest mb-0.5" style={{ letterSpacing: '0.14em' }}>
                      Auto-send
                    </span>
                    AI drafts and sends automatically
                  </button>
                </div>
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
