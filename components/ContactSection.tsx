'use client';

import { useState, useEffect } from 'react';
import type {
  ContactEnrichment, Expert, ProjectExpert,
  ContactPathSuggestion, PublicContactEmail,
} from '../types';
import { extractDomain } from '../lib/extractDomain';
import { suggestDomainsForExpert, type SuggestedDomain } from '../lib/domainSuggestions';
import { isFullHumanName } from '../lib/nameValidation';
import EmailStatusBadge from './EmailStatusBadge';
import OutreachModal from './OutreachModal';

interface Props {
  expert: Expert;
  query: string;
  // Project context — when provided, a successful lookup/resolution is persisted.
  // No paid API is called on mount; persistence only happens after explicit user action.
  projectId?: string;
  expertId?: string;
  onContactUpdated?: (updated: ProjectExpert) => void;
  // Start in confirming state immediately (used by ScreeningCard / OutreachCard)
  initialState?: 'idle' | 'confirming';
  // Pre-populate resolved paths from a previously persisted ContactPathSuggestion.
  // When provided, pathState starts as 'resolved' so chips and public emails appear
  // immediately without re-running the resolver. No API call on mount.
  initialResolvedPaths?: ContactPathSuggestion;
}

type PathState = 'idle' | 'resolving' | 'resolved' | 'resolve_error';

type EmailState =
  | 'idle'
  | 'confirming'
  | 'loading'
  | 'found'
  | 'not_found'
  | 'error'
  | 'unavailable';

// ─── Validation helpers ────────────────────────────────────────────────────────

const WEBMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'mac.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'proton.ch',
  'zoho.com', 'zohomail.com', 'mail.com',
  'fastmail.com', 'fastmail.fm', 'hey.com',
  'tutanota.com', 'tutanota.de',
]);

function normalizeDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/^www\./i, '')
    .toLowerCase()
    .trim();
}

function validateDomain(raw: string): string | null {
  const d = normalizeDomain(raw);
  if (!d) return 'Domain is required';
  if (!d.includes('.')) return 'Enter a valid domain (e.g. acmecorp.com)';
  if (WEBMAIL_DOMAINS.has(d)) return 'Enter a company domain, not a personal email provider';
  if (/\.(local|internal|localhost|test|example|invalid)$/i.test(d)) return 'Internal/reserved domain not allowed';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) return 'IP addresses are not allowed';
  return null;
}

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ─── Chip styling ──────────────────────────────────────────────────────────────

function chipClass(confidence: SuggestedDomain['confidence']): string {
  if (confidence === 'high') {
    return 'border-frame bg-cream hover:border-navy hover:text-navy text-navy font-medium transition-colors';
  }
  if (confidence === 'medium') {
    return 'border-frame bg-cream hover:border-navy hover:text-navy text-ink transition-colors';
  }
  return 'border-frame bg-cream hover:border-navy hover:text-navy text-muted transition-colors';
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function ContactSection({
  expert, query, projectId, expertId, onContactUpdated, initialState = 'idle',
  initialResolvedPaths,
}: Props) {
  const [isOpen, setIsOpen] = useState(initialState !== 'idle');

  // Local suggestions — computed once, never re-fetched
  const [localSuggestions] = useState<SuggestedDomain[]>(() => suggestDomainsForExpert(expert));

  // ── Path resolution state ──
  // If initialResolvedPaths is provided and has content, start as 'resolved' so
  // domain chips and public emails appear immediately without re-running the resolver.
  const hasInitialPaths = !!(
    initialResolvedPaths &&
    (initialResolvedPaths.domains.length > 0 || initialResolvedPaths.publicContactEmails.length > 0)
  );
  const [pathState, setPathState]         = useState<PathState>(hasInitialPaths ? 'resolved' : 'idle');
  const [resolvedPaths, setResolvedPaths] = useState<ContactPathSuggestion | null>(initialResolvedPaths ?? null);

  // ── Email lookup state ──
  const [emailState, setEmailState]   = useState<EmailState>(
    initialState === 'confirming' ? 'confirming' : 'idle',
  );
  const [firstName, setFirstName]     = useState('');
  const [lastName, setLastName]       = useState('');
  const [domain, setDomain]           = useState('');
  const [domainError, setDomainError] = useState('');
  const [enrichment, setEnrichment]   = useState<ContactEnrichment | null>(null);
  const [emailErrorMsg, setEmailErrorMsg] = useState('');
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestedDomain | null>(null);

  // ── Outreach modal state ──
  const [outreachTarget, setOutreachTarget] = useState<{
    email?: string;
    mode: 'personal_expert' | 'general_company_contact';
    generalContactEmail?: string;
  } | null>(null);

  // Merged domain suggestions: local first, then resolved (deduped)
  const localDomainSet = new Set(localSuggestions.map(s => s.domain));
  const extraDomains   = (resolvedPaths?.domains ?? []).filter(d => !localDomainSet.has(d.domain));
  const allSuggestions: SuggestedDomain[] = [...localSuggestions, ...extraDomains];

  const publicEmails: PublicContactEmail[] = resolvedPaths?.publicContactEmails ?? [];

  // Pre-fill name + domain from expert data (no API call)
  function prefillForm() {
    const parts = expert.name.trim().split(/\s+/);
    setFirstName(parts[0] ?? '');
    setLastName(parts.slice(1).join(' '));
    const firstHigh = localSuggestions.find(s => s.confidence === 'high');
    const inferred  = firstHigh?.domain ?? extractDomain(expert) ?? '';
    setDomain(inferred);
    setActiveSuggestion(firstHigh ?? null);
    setDomainError('');
  }

  // When starting in confirming state, pre-fill on mount (no API call)
  useEffect(() => {
    if (initialState === 'confirming') prefillForm();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleToggle() {
    if (isOpen) { setIsOpen(false); return; }
    prefillForm();
    setIsOpen(true);
  }

  // Clicking any domain chip pre-fills the email lookup form and opens it
  function handleSuggestionClick(s: SuggestedDomain) {
    setDomain(s.domain);
    setActiveSuggestion(s);
    setDomainError('');
    if (emailState === 'idle') setEmailState('confirming');
  }

  function handleDomainChange(value: string) {
    setDomain(value);
    setDomainError('');
    if (activeSuggestion && value !== activeSuggestion.domain) setActiveSuggestion(null);
  }

  function handleDomainBlur() {
    if (domain) setDomainError(validateDomain(domain) ?? '');
  }

  const domainIsValid    = domain.trim().length > 0 && validateDomain(domain) === null;
  const firstNameIsValid = /^[a-zA-Z\s'\-.]+$/.test(firstName.trim()) && firstName.trim().length > 0;
  const lastNameIsValid  = /^[a-zA-Z\s'\-.]+$/.test(lastName.trim())  && lastName.trim().length > 0;
  // Identity gate: the expert's stored name must be a verifiable full human name.
  // This prevents spending email-provider credits on unresolved partial names like "J. Subbiah".
  const expertNameIsValid = isFullHumanName(expert.name);
  const canSubmit         = domainIsValid && firstNameIsValid && lastNameIsValid
                            && expertNameIsValid && emailState !== 'loading';

  // ── Path resolver ──────────────────────────────────────────────────────────

  async function handleResolvePaths(forceRefresh = false) {
    setPathState('resolving');
    try {
      const sourceLinks = expert.source_links.map(l => ({
        url: l.url, label: l.label, type: l.type,
      }));
      const res = await fetch('/api/resolve-contact-paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expertName: expert.name,
          title:      expert.title,
          company:    expert.company,
          sourceLinks,
          forceRefresh,
        }),
      });
      if (!res.ok) { setPathState('resolve_error'); return; }
      const data  = await res.json() as { paths?: ContactPathSuggestion };
      const paths = data.paths ?? { domains: [], publicContactEmails: [], resolvedAt: Date.now() };
      setResolvedPaths(paths);
      setPathState('resolved');

      // Persist to project — no PII logged by the PATCH route
      if (projectId && expertId) {
        try {
          const patchRes = await fetch(`/api/projects/${projectId}/experts/${expertId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              suggestedDomains:    paths.domains,
              publicContactEmails: paths.publicContactEmails,
            }),
          });
          const patchData = await patchRes.json() as { project?: { experts: ProjectExpert[] } };
          if (patchRes.ok && patchData.project) {
            const updatedPE = patchData.project.experts.find(pe => pe.expert.id === expertId);
            if (updatedPE) onContactUpdated?.(updatedPE);
          }
        } catch {
          console.warn('[ContactSection] failed to persist contact paths to project');
        }
      }
    } catch {
      setPathState('resolve_error');
    }
  }

  // ── Email lookup ───────────────────────────────────────────────────────────

  async function handleFindEmail(forceRefresh = false) {
    const domainErr = validateDomain(domain);
    if (domainErr) { setDomainError(domainErr); return; }

    setEmailState('loading');
    setEmailErrorMsg('');

    try {
      const res = await fetch('/api/enrich-contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          expertId:     expert.id,
          firstName:    firstName.trim(),
          lastName:     lastName.trim(),
          domain:       normalizeDomain(domain),
          forceRefresh,
        }),
      });
      const data = await res.json() as Record<string, unknown>;

      if (res.status === 503 || res.status === 401) {
        setEmailState('unavailable');
        return;
      }
      if (res.status === 429) {
        const retryMs  = (data.retryAfterMs as number) ?? 60_000;
        const retryMin = Math.ceil(retryMs / 60_000);
        setEmailErrorMsg(`Too many requests. Try again in ${retryMin} minute${retryMin !== 1 ? 's' : ''}.`);
        setEmailState('error');
        return;
      }
      if (res.status === 402) {
        setEmailErrorMsg('Insufficient email-provider credits to perform this lookup.');
        setEmailState('error');
        return;
      }
      if (res.status === 504) {
        const timedOut = data.timedOutProvider as string | undefined;
        setEmailErrorMsg(timedOut === 'hunter'
          ? 'Snov found no professional email. Hunter timed out — try again later.'
          : 'Email lookup timed out — try again later.',
        );
        setEmailState('error');
        return;
      }
      if (!res.ok) {
        setEmailErrorMsg('Lookup failed. Please try again.');
        setEmailState('error');
        return;
      }

      const result = data.enrichment as ContactEnrichment;
      setEnrichment(result);
      setEmailState(result.best_email ? 'found' : 'not_found');

      // Persist contact fields to ProjectExpert — email value never logged server-side
      if (projectId && expertId) {
        const patch: Record<string, unknown> = {
          emailCheckedAt:          result.looked_up_at,
          emailProvider:           result.provider !== 'none' ? result.provider : 'none',
          emailVerificationStatus: result.best_email ? result.best_email.status : 'not_found',
          ...(result.best_email ? { contactEmail: result.best_email.email } : {}),
        };
        try {
          const patchRes  = await fetch(`/api/projects/${projectId}/experts/${expertId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(patch),
          });
          const patchData = await patchRes.json() as { project?: { experts: ProjectExpert[] } };
          if (patchRes.ok && patchData.project) {
            const updatedPE = patchData.project.experts.find(pe => pe.expert.id === expertId);
            if (updatedPE) onContactUpdated?.(updatedPE);
          }
        } catch {
          console.warn('[ContactSection] failed to persist contact email to project');
        }
      }
    } catch {
      setEmailErrorMsg('Network error. Please try again.');
      setEmailState('error');
    }
  }

  async function handleRecheck() {
    if (!window.confirm('Re-checking may spend one or more contact lookup credits. Continue?')) return;
    await handleFindEmail(true);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!isOpen) {
    return (
      <div className="pt-3 border-t border-frame mt-1">
        <button
          onClick={handleToggle}
          className="text-[11px] uppercase tracking-widest text-muted hover:text-navy transition-colors font-medium flex items-center gap-1.5"
          style={{ minHeight: '32px' }}
        >
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Contact
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="pt-3 border-t border-frame mt-1 space-y-4">
        <SectionHeader onCollapse={handleToggle} />

        {/* ── Section 1: Suggested contact paths ─────────────────────────── */}
        <div className="space-y-2.5">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium">
            Suggested contact paths
          </p>

          {/* Local domain chips — always shown, zero API calls */}
          {localSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {localSuggestions.map(s => (
                <button
                  key={s.domain}
                  type="button"
                  onClick={() => handleSuggestionClick(s)}
                  title={s.reason}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border ${chipClass(s.confidence)}`}
                >
                  {s.confidence === 'high' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
                  )}
                  {s.domain}
                </button>
              ))}
            </div>
          )}

          {/* Resolve button */}
          {pathState === 'idle' && (
            <button
              onClick={() => handleResolvePaths(false)}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors flex items-center gap-1.5"
              style={{ minHeight: '28px' }}
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Find contact paths
            </button>
          )}

          {/* Resolver spinner */}
          {pathState === 'resolving' && (
            <div className="flex items-center gap-2 text-[10px] text-muted">
              <span className="inline-block w-3 h-3 border border-navy border-t-transparent rounded-full animate-spin" />
              Searching for contact paths…
            </div>
          )}

          {/* Resolver error */}
          {pathState === 'resolve_error' && (
            <p className="text-[10px] text-red-600">
              Could not resolve contact paths.{' '}
              <button
                onClick={() => handleResolvePaths(false)}
                className="underline hover:text-red-800 transition-colors"
              >
                Retry
              </button>
            </p>
          )}

          {/* Resolver results */}
          {pathState === 'resolved' && resolvedPaths && (
            <>
              {/* Additional domains from search */}
              {extraDomains.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {extraDomains.map(s => (
                    <button
                      key={s.domain}
                      type="button"
                      onClick={() => handleSuggestionClick(s)}
                      title={s.reason}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border ${chipClass(s.confidence)}`}
                    >
                      {s.confidence === 'high' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
                      )}
                      {s.domain}
                    </button>
                  ))}
                </div>
              )}

              {/* Public contact emails (role-based, not personal) */}
              {publicEmails.length > 0 && (
                <div className="space-y-2 mt-0.5">
                  {publicEmails.map(e => (
                    <div key={e.email} className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <a
                          href={`mailto:${e.email}`}
                          className="text-xs text-navy font-medium hover:underline underline-offset-2 truncate"
                        >
                          {e.email}
                        </a>
                        <span className="text-[9px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 uppercase tracking-wide whitespace-nowrap shrink-0">
                          Company inbox
                        </span>
                      </div>
                      <button
                        onClick={() => setOutreachTarget({
                          mode: 'general_company_contact',
                          generalContactEmail: e.email,
                        })}
                        className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors whitespace-nowrap shrink-0"
                      >
                        Draft outreach
                      </button>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted leading-snug">
                    General inboxes may not reach {expert.name.split(' ')[0]} directly — the draft
                    will ask to be forwarded.
                  </p>
                </div>
              )}

              {/* Nothing new found */}
              {extraDomains.length === 0 && publicEmails.length === 0 && (
                <p className="text-[10px] text-muted">
                  No additional contact paths found via search.{' '}
                  <button
                    onClick={() => handleResolvePaths(true)}
                    className="underline hover:text-navy transition-colors"
                  >
                    Refresh
                  </button>
                </p>
              )}

              {/* Refresh link when results exist */}
              {(extraDomains.length > 0 || publicEmails.length > 0) && (
                <button
                  onClick={() => handleResolvePaths(true)}
                  className="text-[10px] text-muted hover:text-navy transition-colors"
                  title="Re-run search (no credits spent)"
                >
                  ↻ Refresh
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Divider ── */}
        <div className="border-t border-frame" />

        {/* ── Section 2: Professional email lookup ───────────────────────── */}
        <div className="space-y-2.5">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium">
            Professional Email
          </p>

          {emailState === 'unavailable' && (
            <p className="text-xs text-muted">Contact enrichment not available.</p>
          )}

          {emailState === 'idle' && (
            <button
              onClick={() => setEmailState('confirming')}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors flex items-center gap-1.5"
              style={{ minHeight: '28px' }}
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Find professional email
            </button>
          )}

          {emailState === 'confirming' && (
            <>
              {!expertNameIsValid && (
                <div className="flex items-start gap-2 px-3 py-2.5 border border-amber-200 bg-amber-50 text-xs text-amber-800 leading-snug">
                  <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <span>
                    <strong className="font-medium">Incomplete name.</strong>{' '}
                    Email lookup requires a verified full first and last name. This expert&apos;s name could not be confirmed — edit it above before proceeding.
                  </span>
                </div>
              )}
              <ConfirmingForm
                firstName={firstName}
                lastName={lastName}
                domain={domain}
                domainError={domainError}
                canSubmit={canSubmit}
                suggestions={allSuggestions}
                activeSuggestion={activeSuggestion}
                onFirstNameChange={v => setFirstName(v)}
                onLastNameChange={v => setLastName(v)}
                onDomainChange={handleDomainChange}
                onDomainBlur={handleDomainBlur}
                onSuggestionClick={handleSuggestionClick}
                onSubmit={() => handleFindEmail(false)}
              />
            </>
          )}

          {emailState === 'loading' && (
            <div className="flex items-center gap-2 text-xs text-muted py-1">
              <span className="inline-block w-3.5 h-3.5 border border-navy border-t-transparent rounded-full animate-spin" />
              Searching for professional email…
            </div>
          )}

          {emailState === 'found' && enrichment?.best_email && (
            <FoundResult
              enrichment={enrichment}
              onRecheck={handleRecheck}
              onOutreach={() => setOutreachTarget({
                email: enrichment.best_email?.email,
                mode:  'personal_expert',
              })}
            />
          )}

          {emailState === 'not_found' && enrichment && (
            <NotFoundResult
              domain={enrichment.domain_used}
              lookedUpAt={enrichment.looked_up_at}
              suggestions={allSuggestions}
              onRetry={() => {
                setDomain('');
                setActiveSuggestion(null);
                setDomainError('');
                setEmailState('confirming');
              }}
              onTryDomain={(d, s) => {
                setDomain(d);
                setActiveSuggestion(s ?? null);
                setDomainError('');
                setEmailState('confirming');
              }}
            />
          )}

          {emailState === 'error' && (
            <div className="space-y-2">
              <p className="text-xs text-red-600">{emailErrorMsg}</p>
              <button
                onClick={() => setEmailState('confirming')}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>

      {outreachTarget && (
        <OutreachModal
          expert={expert}
          query={query}
          prefillEmail={outreachTarget.email}
          outreachMode={outreachTarget.mode}
          generalContactEmail={outreachTarget.generalContactEmail}
          onClose={() => setOutreachTarget(null)}
        />
      )}
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Contact</p>
      <button
        onClick={onCollapse}
        className="text-muted hover:text-navy transition-colors p-1"
        aria-label="Collapse contact section"
        style={{ minWidth: '24px', minHeight: '24px' }}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>
    </div>
  );
}

interface ConfirmingFormProps {
  firstName: string;
  lastName: string;
  domain: string;
  domainError: string;
  canSubmit: boolean;
  suggestions: SuggestedDomain[];
  activeSuggestion: SuggestedDomain | null;
  onFirstNameChange: (v: string) => void;
  onLastNameChange:  (v: string) => void;
  onDomainChange:    (v: string) => void;
  onDomainBlur:      () => void;
  onSuggestionClick: (s: SuggestedDomain) => void;
  onSubmit:          () => void;
}

function ConfirmingForm({
  firstName, lastName, domain, domainError, canSubmit,
  suggestions, activeSuggestion,
  onFirstNameChange, onLastNameChange, onDomainChange, onDomainBlur,
  onSuggestionClick, onSubmit,
}: ConfirmingFormProps) {
  // Only show suggestions that differ from the current domain value
  const visibleSuggestions = suggestions.filter(s => s.domain !== domain);

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] text-muted leading-relaxed">
        Review and confirm before searching.
      </p>

      {/* Name row */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted mb-1">First</label>
          <input
            type="text"
            value={firstName}
            onChange={e => onFirstNameChange(e.target.value)}
            placeholder="First name"
            className="w-full px-2.5 py-1.5 text-xs border border-frame bg-cream focus:outline-none focus:border-navy focus:ring-1 focus:ring-gold/30 text-navy"
            maxLength={50}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted mb-1">Last</label>
          <input
            type="text"
            value={lastName}
            onChange={e => onLastNameChange(e.target.value)}
            placeholder="Last name"
            className="w-full px-2.5 py-1.5 text-xs border border-frame bg-cream focus:outline-none focus:border-navy focus:ring-1 focus:ring-gold/30 text-navy"
            maxLength={80}
            autoComplete="off"
          />
        </div>
      </div>

      {/* Domain */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-muted mb-1">
          Company domain
        </label>
        <input
          type="text"
          value={domain}
          onChange={e => onDomainChange(e.target.value)}
          onBlur={onDomainBlur}
          placeholder="e.g. acmecorp.com"
          className={`w-full px-2.5 py-1.5 text-xs border bg-cream focus:outline-none focus:ring-1 text-navy ${
            domainError
              ? 'border-red-300 focus:border-red-400 focus:ring-red-200'
              : 'border-frame focus:border-navy focus:ring-gold/30'
          }`}
          maxLength={253}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {domainError && (
          <p className="text-[10px] text-red-600 mt-1">{domainError}</p>
        )}
        {!domainError && activeSuggestion && (
          <p className="text-[10px] text-muted mt-1 leading-snug">{activeSuggestion.reason}</p>
        )}
        {visibleSuggestions.length > 0 && (
          <div className="mt-1.5">
            <p className="text-[10px] text-muted mb-1">Other options:</p>
            <div className="flex flex-wrap gap-1">
              {visibleSuggestions.map(s => (
                <button
                  key={s.domain}
                  type="button"
                  onClick={() => onSuggestionClick(s)}
                  title={s.reason}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border ${chipClass(s.confidence)}`}
                >
                  {s.confidence === 'high' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
                  )}
                  {s.domain}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className="w-full bg-navy text-cream text-[10px] font-medium uppercase tracking-widest py-2.5 px-3 transition-all duration-200 hover:bg-navy-light disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ letterSpacing: '0.12em', minHeight: '36px' }}
      >
        Find professional email
      </button>
    </div>
  );
}

function FoundResult({
  enrichment, onRecheck, onOutreach,
}: {
  enrichment: ContactEnrichment;
  onRecheck:  () => void;
  onOutreach: () => void;
}) {
  const { best_email, looked_up_at } = enrichment;
  if (!best_email) return null;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`mailto:${best_email.email}`}
            className="text-xs text-navy font-medium hover:underline underline-offset-2"
          >
            {best_email.email}
          </a>
          <EmailStatusBadge status={best_email.status} />
        </div>
        {best_email.status === 'catchall' && (
          <p className="text-[10px] text-muted">
            This company uses catch-all email routing — delivery not guaranteed.
          </p>
        )}
      </div>

      <p className="text-[10px] text-muted">
        Source: {enrichment.provider === 'hunter' ? 'Hunter.io' : 'Snov.io'} · Checked:{' '}
        {formatDate(looked_up_at)}
      </p>

      <div className="flex items-center gap-3 pt-0.5">
        <button
          onClick={onOutreach}
          className="flex-1 bg-navy text-cream text-[10px] font-medium uppercase tracking-widest py-2.5 px-3 transition-all hover:bg-navy-light flex items-center justify-center gap-1.5"
          style={{ letterSpacing: '0.12em', minHeight: '36px' }}
        >
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          Generate outreach
        </button>
        <button
          onClick={onRecheck}
          className="text-[10px] text-muted hover:text-navy transition-colors uppercase tracking-widest"
          title="Re-check (may spend contact lookup credits)"
        >
          Re-check ↻
        </button>
      </div>
    </div>
  );
}

function NotFoundResult({
  domain, lookedUpAt, suggestions, onRetry, onTryDomain,
}: {
  domain:      string;
  lookedUpAt:  number;
  suggestions: SuggestedDomain[];
  onRetry:     () => void;
  onTryDomain: (domain: string, suggestion?: SuggestedDomain) => void;
}) {
  const alternatives = suggestions.filter(s => s.domain !== domain);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        No professional email found for{' '}
        <span className="font-medium text-navy">{domain}</span>.
        {alternatives.length > 0 ? ' Try a different domain.' : ''}
      </p>

      {alternatives.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {alternatives.map(s => (
            <button
              key={s.domain}
              type="button"
              onClick={() => onTryDomain(s.domain, s)}
              title={s.reason}
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border ${chipClass(s.confidence)}`}
            >
              {s.confidence === 'high' && (
                <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
              )}
              {s.domain}
            </button>
          ))}
        </div>
      )}

      <p className="text-[10px] text-muted">Checked: {formatDate(lookedUpAt)}</p>
      <button
        onClick={onRetry}
        className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
      >
        Try a different domain
      </button>
    </div>
  );
}
