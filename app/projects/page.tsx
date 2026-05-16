'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProjectSummary } from '../../types';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Delete button ─────────────────────────────────────────────────────────────

function DeleteProjectButton({
  projectId,
  projectName,
  onDeleted,
}: {
  projectId: string;
  projectName: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting,   setDeleting]   = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (res.ok) onDeleted();
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div
        className="flex items-center gap-2"
        onClick={e => e.preventDefault()}   // prevent row navigation
      >
        <span className="text-[10px] text-red-600">Delete this project? This cannot be undone.</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-[10px] uppercase tracking-widest text-red-600 border border-red-300 bg-red-50 hover:bg-red-100 px-2.5 py-1 transition-colors disabled:opacity-40"
          style={{ letterSpacing: '0.1em' }}
        >
          {deleting ? 'Deleting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={e => { e.preventDefault(); setConfirming(true); }}
      title={`Delete "${projectName}"`}
      className="text-muted/40 hover:text-red-500 transition-colors p-1 shrink-0"
      aria-label={`Delete ${projectName}`}
    >
      {/* Trash icon */}
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((d: { projects?: ProjectSummary[] }) => setProjects(d.projects ?? []))
      .catch(() => setError('Failed to load projects.'))
      .finally(() => setLoading(false));
  }, []);

  function handleDeleted(id: string) {
    setProjects(prev => prev.filter(p => p.id !== id));
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* Header */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link href="/app" className="flex items-center gap-3">
            <svg className="w-5 h-5 text-gold shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <span
              className="font-display text-cream font-semibold tracking-widest"
              style={{ letterSpacing: '0.15em', fontSize: '13px' }}
            >
              EXPERTMATCH
            </span>
          </Link>
          <span
            className="text-[10px] uppercase tracking-widest text-gold/70"
            style={{ letterSpacing: '0.18em' }}
          >
            Projects
          </span>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 sm:px-10 py-12">
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-2xl font-semibold text-navy" style={{ letterSpacing: '-0.01em' }}>
              Project Workspaces
            </h1>
            <p className="text-sm text-muted mt-1" style={{ fontWeight: 300 }}>
              Saved expert searches with pipeline tracking and export.
            </p>
          </div>
          <Link
            href="/app"
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2.5 transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            + New Search
          </Link>
        </div>

        <div className="rule-divider mb-8" />

        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-cream border border-frame p-5 space-y-2">
                <div className="skeleton h-4 w-1/3 rounded" />
                <div className="skeleton h-3 w-2/3 rounded" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 border border-red-200 bg-red-50 px-4 py-3">{error}</p>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="py-20 max-w-md">
            <p className="font-display text-xl text-navy font-light italic">No projects yet.</p>
            <p className="mt-3 text-sm text-muted" style={{ fontWeight: 300 }}>
              Run a search and click "Save as Project" to create a workspace with pipeline tracking.
            </p>
            <div className="mt-6">
              <Link
                href="/app"
                className="inline-block bg-navy text-cream text-xs uppercase tracking-widest px-5 py-3 hover:bg-navy-light transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                Start a Search
              </Link>
            </div>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="space-y-3">
            {projects.map(p => (
              <div
                key={p.id}
                className="bg-cream border border-frame hover:border-navy/40 transition-colors group relative"
              >
                <div className="p-5 flex items-start justify-between gap-4">
                  {/* Clickable main area */}
                  <Link
                    href={`/projects/${p.id}`}
                    className="flex-1 min-w-0 flex items-start justify-between gap-6"
                  >
                    <div className="flex-1 min-w-0">
                      <h2 className="font-display text-base font-semibold text-navy group-hover:underline underline-offset-2 leading-snug">
                        {p.name}
                      </h2>
                      <p className="text-xs text-muted mt-1 line-clamp-1" style={{ fontWeight: 300 }}>
                        {p.researchQuestion}
                      </p>
                    </div>
                    <div className="shrink-0 text-right space-y-1">
                      <div className="flex items-center gap-3 justify-end">
                        <span className="text-[10px] text-muted">{p.expertCount} expert{p.expertCount !== 1 ? 's' : ''}</span>
                        {p.shortlistedCount > 0 && (
                          <span className="text-[10px] text-amber-700 border border-amber-200 bg-amber-50 px-1.5 py-0.5">
                            ★ {p.shortlistedCount}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted">{formatDate(p.updatedAt)}</p>
                    </div>
                  </Link>

                  {/* Delete button — visually secondary, sits outside the Link */}
                  <DeleteProjectButton
                    projectId={p.id}
                    projectName={p.name}
                    onDeleted={() => handleDeleted(p.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
