'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProjectSummary } from '../../types';

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

interface CurrentUser {
  email:      string;
  role:       'admin' | 'user';
  firmDomain: string;
}

export default function AppPage() {
  const router = useRouter();

  // Projects
  const [projects,        setProjects]        = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [currentUser,     setCurrentUser]     = useState<CurrentUser | null>(null);
  const [showWelcome,     setShowWelcome]     = useState(false);

  // New Project modal
  const [showNewProjectModal, setShowNewProjectModal]   = useState(false);
  const [briefProblem,        setBriefProblem]          = useState('');
  const [briefExpertType,     setBriefExpertType]       = useState('');
  const [outreachMode,        setOutreachMode]          = useState<'auto' | 'review'>('review');
  const [creating,            setCreating]              = useState(false);
  const [createError,         setCreateError]           = useState('');

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

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Welcome banner (shown once after onboarding) ── */}
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
            href="/app"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={openNewProjectModal}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors"
              style={{
                background: '#C6A75E',
                color:      '#0B1F3B',
                letterSpacing: '0.14em',
              }}
            >
              New Project
            </button>
            <button
              onClick={handleSignOut}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors border"
              style={{
                color:       'rgba(198,167,94,0.6)',
                borderColor: 'rgba(198,167,94,0.25)',
                letterSpacing: '0.14em',
              }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* ── Projects ── */}
      <div className="border-b border-frame bg-surface">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-5" style={{ letterSpacing: '0.2em' }}>
            Projects
          </p>

          {projectsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-cream border border-frame px-4 py-3.5 flex items-center gap-6">
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton h-3.5 w-1/2 rounded" />
                    <div className="skeleton h-3 w-3/4 rounded" />
                  </div>
                  <div className="shrink-0 flex items-center gap-5">
                    <div className="skeleton h-3 w-16 rounded hidden sm:block" />
                    <div className="skeleton h-3 w-20 rounded hidden md:block" />
                    <div className="skeleton h-3 w-10 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : projects.length > 0 ? (
            <div className="space-y-2">
              {[...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(p => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-6 bg-cream border border-frame hover:border-navy/40 px-4 py-3.5 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-navy group-hover:underline underline-offset-2 leading-snug truncate">
                      {p.name || (p.researchQuestion ? p.researchQuestion.slice(0, 60) : 'Untitled Project')}
                    </p>
                    {p.researchQuestion && (
                      <p className="text-[11px] text-muted mt-0.5 truncate leading-relaxed" style={{ fontWeight: 300 }}>
                        {p.researchQuestion}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-5">
                    {currentUser && p.ownerEmail && p.ownerEmail !== currentUser.email && (
                      <span className="text-[10px] text-muted hidden sm:block italic">
                        Shared by {p.ownerEmail.split('@')[0].split('.')[0]}
                      </span>
                    )}
                    {currentUser && p.ownerEmail === currentUser.email && (p.collaborators?.length ?? 0) > 0 && (
                      <span className="text-[10px] text-muted hidden sm:block">
                        Shared with {p.collaborators.length}
                      </span>
                    )}
                    <span className="text-[10px] text-muted hidden sm:block">
                      {p.expertCount} expert{p.expertCount !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px] text-muted hidden md:block">
                      {formatDate(p.updatedAt)}
                    </span>
                    <span
                      className="text-[10px] uppercase font-medium group-hover:text-navy transition-colors"
                      style={{ color: '#C6A75E', letterSpacing: '0.12em' }}
                    >
                      Open →
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="py-10 text-center border border-dashed border-frame" style={{ background: 'rgba(247,249,252,0.6)' }}>
              <p className="text-sm text-muted mb-4">No projects yet. Create a project to get started.</p>
              <button
                onClick={openNewProjectModal}
                className="text-[10px] uppercase font-medium px-5 py-2.5 transition-colors"
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
                      background:    outreachMode === 'review' ? '#0B1F3B' : 'transparent',
                      color:         outreachMode === 'review' ? '#C6A75E' : '#6B7C8D',
                      borderRight:   '1px solid #E2E8ED',
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
