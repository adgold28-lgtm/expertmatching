'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Expert, ExpertStatus, QueryAnalysis, ProjectSummary } from '../types';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ExpertWithStatus {
  expert: Expert;
  status: ExpertStatus;
}

interface BriefFields {
  industry?:           string;
  function?:           string;
  timeline?:           string;
  targetExpertCount?:  string;
  keyQuestions?:       string;
  initialHypotheses?:  string;
  conflictExclusions?: string;
}

interface Props {
  query: string;
  geography: string;
  seniority: string;
  queryAnalysis: QueryAnalysis;
  experts: ExpertWithStatus[];
  onClose: () => void;
  // Full brief state from the homepage form — carries user-typed values and
  // advanced brief fields that should be persisted alongside the project.
  briefFields?: BriefFields;
}

type Mode = 'new' | 'existing';

export default function ProjectSaveModal({ query, geography, seniority, queryAnalysis, experts, onClose, briefFields }: Props) {
  const router   = useRouter();
  const modalRef = useRef<HTMLDivElement>(null);

  const [mode,       setMode]       = useState<Mode>('new');
  const [name,       setName]       = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [projects,   setProjects]   = useState<ProjectSummary[]>([]);
  const [targetId,   setTargetId]   = useState('');
  const [loadingPrs, setLoadingPrs] = useState(false);

  useFocusTrap(modalRef, onClose);

  const shortlistedCount = experts.filter(e => e.status === 'shortlisted').length;
  const rejectedCount    = experts.filter(e => e.status === 'rejected').length;

  useEffect(() => {
    if (mode !== 'existing') return;
    setLoadingPrs(true);
    fetch('/api/projects')
      .then(r => r.json())
      .then((d: { projects?: ProjectSummary[] }) => { setProjects(d.projects ?? []); })
      .catch(() => { setError('Failed to load projects.'); })
      .finally(() => setLoadingPrs(false));
  }, [mode]);

  async function handleSaveNew() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Project name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      // Prefer user-typed industry/function over LLM-detected values from queryAnalysis
      const industry = briefFields?.industry?.trim() || queryAnalysis.industry;
      const fn       = briefFields?.function?.trim()  || queryAnalysis.function;

      const res  = await fetch('/api/projects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:             trimmed,
          researchQuestion: query,
          industry,
          function:         fn,
          geography:        geography !== 'any' ? geography : '',
          seniority:        seniority !== 'any' ? seniority : '',
          experts,
        }),
      });
      const data = await res.json() as { project?: { id: string }; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to save.'); return; }

      const projectId = data.project!.id;

      // PATCH optional brief extras if provided — mirrors handleCreateProjectBrief in app/page.tsx
      if (briefFields) {
        const extras: Record<string, unknown> = {};
        if (briefFields.timeline?.trim())           extras.timeline           = briefFields.timeline.trim();
        if (briefFields.targetExpertCount?.trim())  extras.targetExpertCount  = parseInt(briefFields.targetExpertCount, 10);
        if (briefFields.keyQuestions?.trim())       extras.keyQuestions       = briefFields.keyQuestions.trim();
        if (briefFields.initialHypotheses?.trim())  extras.initialHypotheses  = briefFields.initialHypotheses.trim();
        if (briefFields.conflictExclusions?.trim()) extras.conflictExclusions = briefFields.conflictExclusions.trim();

        if (Object.keys(extras).length > 0) {
          await fetch(`/api/projects/${projectId}`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(extras),
          });
        }
      }

      router.push(`/projects/${projectId}`);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddToExisting() {
    if (!targetId) { setError('Please select a project.'); return; }
    setSaving(true);
    setError('');
    try {
      const res  = await fetch(`/api/projects/${targetId}/experts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ experts }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to add experts.'); return; }
      router.push(`/projects/${targetId}`);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(11,31,59,0.55)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className="bg-cream border border-frame w-full max-w-lg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Save as Project"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-frame">
          <p className="text-[11px] uppercase tracking-widest text-navy font-medium" style={{ letterSpacing: '0.18em' }}>
            Save to Project
          </p>
          <button onClick={onClose} className="text-muted hover:text-navy transition-colors p-1" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Expert summary */}
        <div className="px-6 pt-4 pb-2 flex flex-wrap gap-x-5 gap-y-1">
          <span className="text-[11px] text-muted">{experts.length} experts</span>
          {shortlistedCount > 0 && (
            <span className="text-[11px] text-amber-700">★ {shortlistedCount} shortlisted</span>
          )}
          {rejectedCount > 0 && (
            <span className="text-[11px] text-red-500">✗ {rejectedCount} rejected</span>
          )}
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-frame px-6">
          {(['new', 'existing'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(''); }}
              className={`text-[10px] uppercase tracking-widest py-3 mr-5 border-b-2 transition-colors ${
                mode === m
                  ? 'border-navy text-navy'
                  : 'border-transparent text-muted hover:text-navy'
              }`}
            >
              {m === 'new' ? 'New Project' : 'Add to Existing'}
            </button>
          ))}
        </div>

        <div className="px-6 py-5 space-y-4">
          {mode === 'new' ? (
            <>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5">
                  Project Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setError(''); }}
                  placeholder="e.g. Solar Interconnection Diligence — Q3"
                  maxLength={200}
                  autoFocus
                  className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                />
              </div>
              <div className="text-[11px] text-muted space-y-0.5">
                <p>Research question will be saved with the project.</p>
                <p>
                  {briefFields?.industry?.trim() || queryAnalysis.industry}
                  {' · '}
                  {briefFields?.function?.trim() || queryAnalysis.function}
                </p>
              </div>
            </>
          ) : (
            <>
              {loadingPrs ? (
                <p className="text-xs text-muted py-2">Loading projects…</p>
              ) : projects.length === 0 ? (
                <p className="text-xs text-muted py-2">No saved projects yet.</p>
              ) : (
                <div>
                  <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5">
                    Select Project
                  </label>
                  <select
                    value={targetId}
                    onChange={e => { setTargetId(e.target.value); setError(''); }}
                    className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                  >
                    <option value="">Choose a project…</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.expertCount} experts)
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            onClick={mode === 'new' ? handleSaveNew : handleAddToExisting}
            disabled={saving || (mode === 'existing' && (!targetId || projects.length === 0))}
            className="w-full bg-navy text-cream text-[10px] uppercase tracking-widest py-3 hover:bg-navy-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ letterSpacing: '0.12em', minHeight: '44px' }}
          >
            {saving ? 'Saving…' : mode === 'new' ? 'Create Project' : 'Add to Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
