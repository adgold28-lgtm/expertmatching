'use client';

// The whole admin console. /admin/users was folded in here (Session 3, wave 2)
// because the two pages needed each other's data: approving a request creates an
// organization, inviting a member changes a seat count, and disabling a user
// changes what Stripe is billed. Order of sections is the order a founder works
// them: what is waiting on me, what broke, who I have, who is in them, what is
// configured.

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatUsdFromCents } from '../../../lib/pricing';
import { isPublicEmailDomain } from '../../../lib/emailDomains';
import type { FirmTypeValue, FirmSizeValue } from '../../../lib/supabase/database.types';

// ─── Types ────────────────────────────────────────────────────────────────────

type FirmStatus = 'active' | 'disabled';
type UserStatus = 'active' | 'pending' | 'disabled';
type UserRole   = 'admin' | 'user';

interface FirmBilling {
  complete:            boolean;         // card on file + subscription created
  subscriptionStatus:  string | null;   // Stripe mirror
  seatQuantitySynced:  number | null;   // last seat quantity pushed to Stripe
  billingEmail:        string | null;
}

interface FirmInfo {
  id:                     string;
  domain:                 string | null;   // some orgs have no domain
  name:                   string;
  status:                 FirmStatus;
  createdAt:              number;
  seatUsed:               number;
  seatPending:            number;
  seatLimit:              number | null;   // null = unlimited
  seatUnitPriceCents:     number;
  monthlySeatTotalCents:  number;
  billing:                FirmBilling;
}

interface UserInfo {
  email:      string;
  role:       UserRole;
  firstName?: string;
  lastName?:  string;
  orgRole?:   'org_admin' | 'org_member';
  status:     UserStatus;
  createdAt:  number;
  firmName:   string;
  firmDomain: string;
}

interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  firmType:    FirmTypeValue | null;
  firmSize:    FirmSizeValue | null;
  submittedAt: number;
}

interface SeatRequest {
  email:      string;
  firmDomain: string;
  reason:     string;
  status:     string;
  createdAt:  number;
  name?:      string;
  firmName?:  string;
}

/** GET /api/admin/attention — built by another agent; may not exist yet. */
interface AttentionItem {
  id:              string;
  kind:            string;
  message:         string;
  occurredAt:      string;
  organizationId?: string;
  projectId?:      string;
  expertId?:       string;
}

/** GET /api/admin/env-status — presence only, never values. */
interface EnvVar   { name: string; set: boolean; optional?: boolean }
interface EnvGroup { name: string; vars: EnvVar[] }

// ─── Firm phrase vocabulary ───────────────────────────────────────────────────
// Mirrors the check constraints in 20260907000000_matchy_phase1.sql and the
// wording in lib/matchyTemplates.ts — this is the phrase Matchy says to an
// expert, so the founder gets to correct it before the invite goes out.

const FIRM_TYPE_OPTIONS: { value: FirmTypeValue; label: string }[] = [
  { value: 'pe_firm',         label: 'PE firm' },
  { value: 'family_office',   label: 'Family office' },
  { value: 'consulting_firm', label: 'Consulting firm' },
  { value: 'law_firm',        label: 'Law firm' },
  { value: 'hedge_fund',      label: 'Hedge fund' },
  { value: 'corporate',       label: 'Corporate' },
  { value: 'other',           label: 'Other' },
];

const FIRM_SIZE_OPTIONS: { value: FirmSizeValue; label: string }[] = [
  { value: 'boutique', label: 'Boutique' },
  { value: 'mid_size', label: 'Mid-size' },
  { value: 'large',    label: 'Large' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** "Jane Q. Okafor" → { first: 'Jane', last: 'Q. Okafor' } */
function splitName(fullName: string): { first: string; last: string } {
  const clean = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { first: '', last: '' };
  const parts = clean.split(' ');
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function fullName(user: UserInfo): string {
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || user.email;
}

function pluralSeats(n: number): string {
  return `${n} seat${n === 1 ? '' : 's'}`;
}

/** "3 seats · $250/seat · $750/mo · cap 10 · 2 pending" */
function seatSummaryLine(firm: FirmInfo): string {
  const parts = [
    pluralSeats(firm.seatUsed),
    `${formatUsdFromCents(firm.seatUnitPriceCents)}/seat`,
    `${formatUsdFromCents(firm.monthlySeatTotalCents)}/mo`,
  ];
  if (firm.seatLimit !== null)  parts.push(`cap ${firm.seatLimit}`);
  if (firm.seatPending > 0)     parts.push(`${firm.seatPending} pending`);
  return parts.join(' · ');
}

// ─── Billing line ─────────────────────────────────────────────────────────────

type BillingTone = 'ink' | 'muted' | 'warn';

interface BillingLineParts {
  text:     string;
  tone:     BillingTone;
  warning?: string;
}

const LIVE_STATUSES     = ['active', 'trialing'];
const PAST_DUE_STATUSES = ['past_due', 'unpaid'];
const DEAD_STATUSES     = ['canceled', 'incomplete', 'incomplete_expired'];

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

/** "5 seats synced" — with " (app has 6)" appended when Stripe has drifted. */
function syncedSegment(billing: FirmBilling, seatUsed: number): string {
  if (billing.seatQuantitySynced === null) return 'seat count not yet synced';
  const base = `${pluralSeats(billing.seatQuantitySynced)} synced`;
  return billing.seatQuantitySynced === seatUsed ? base : `${base} (app has ${seatUsed})`;
}

function autoBillingText(billing: FirmBilling, seatUsed: number, status: string): string {
  return `Auto-billing on · Stripe subscription ${statusLabel(status)} · ${syncedSegment(billing, seatUsed)}`;
}

function billingLineParts(firm: FirmInfo): BillingLineParts {
  const { billing } = firm;

  if (!billing.complete) {
    // lib/entitlements.ts: a trial is a billing row that says 'trialing' with
    // no card. Everything external stays closed until the champion adds one.
    if (billing.subscriptionStatus === 'trialing') {
      return {
        text: 'Trial account — no card. Sourcing and walkthrough only; outreach, scheduling and billing unlock when a card is added in Settings',
        tone: 'muted',
      };
    }
    return {
      text: "Billing not set up — the first member adds the firm's card during onboarding",
      tone: 'muted',
    };
  }

  const status = billing.subscriptionStatus;

  if (status === null) {
    return { text: 'Card on file · subscription pending', tone: 'muted' };
  }
  if (LIVE_STATUSES.includes(status)) {
    return { text: autoBillingText(billing, firm.seatUsed, status), tone: 'ink' };
  }
  if (PAST_DUE_STATUSES.includes(status)) {
    return {
      text:    autoBillingText(billing, firm.seatUsed, status),
      tone:    'ink',
      warning: 'Payment past due',
    };
  }
  if (DEAD_STATUSES.includes(status)) {
    return { text: `Subscription ${statusLabel(status)} — no active billing`, tone: 'warn' };
  }
  return { text: `Subscription ${statusLabel(status)}`, tone: 'muted' };
}

const TONE_CLASS: Record<BillingTone, string> = {
  ink:   'text-ink',
  muted: 'text-muted',
  warn:  'text-red-600',
};

function BillingLine({ firm, showEmail = false }: { firm: FirmInfo; showEmail?: boolean }) {
  const parts = billingLineParts(firm);
  const email = showEmail ? firm.billing.billingEmail : null;

  return (
    <span className={TONE_CLASS[parts.tone]}>
      {parts.text}
      {email ? ` · billed to ${email}` : ''}
      {parts.warning ? <span className="text-red-600 font-medium">{` · ${parts.warning}`}</span> : null}
    </span>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

const INPUT_CLASS =
  'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50';
const SELECT_CLASS =
  'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy';
const LABEL_CLASS = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';
const ACTION_CLASS =
  'text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0';
const DANGER_CLASS =
  'text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0';
const CONFIRM_DANGER_CLASS =
  'text-[10px] uppercase tracking-widest text-red-600 border border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0';

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-4 mb-5">
      <p
        className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0"
        style={{ letterSpacing: '0.2em' }}
      >
        {title}
      </p>
      <div className="flex-1 h-px bg-frame" />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border border-red-200 bg-red-50 px-4 py-3">
      <p className="text-xs text-red-600">{message}</p>
      <button
        onClick={onRetry}
        className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
        style={{ letterSpacing: '0.12em' }}
      >
        Retry
      </button>
    </div>
  );
}

function SkeletonRows({ count = 2 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="border border-frame bg-cream px-4 py-3">
          <div className="h-3 w-1/2 bg-frame rounded animate-pulse mb-1.5" />
          <div className="h-2.5 w-1/3 bg-frame rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Access request card ──────────────────────────────────────────────────────

function AccessRequestCard({
  req,
  onDone,
}: {
  req:    AccessRequest;
  onDone: () => void;   // refreshes requests AND organizations
}) {
  const prefill = splitName(req.name);

  const [firstName, setFirstName] = useState(prefill.first);
  const [lastName,  setLastName]  = useState(prefill.last);
  const [firmName,  setFirmName]  = useState(req.firm);
  const [firmType,  setFirmType]  = useState<FirmTypeValue | ''>(req.firmType ?? '');
  const [firmSize,  setFirmSize]  = useState<FirmSizeValue | ''>(req.firmSize ?? '');
  // A personal address (Gmail, Outlook…) cannot form an organization, so such
  // a requester can only be approved as a trial tester in a generated org.
  const personalDomain = isPublicEmailDomain(req.email.split('@')[1] ?? '');
  const [trial,     setTrial]     = useState(personalDomain);
  const [loading,   setLoading]   = useState(false);
  const [status,    setStatus]    = useState<'idle' | 'approved' | 'rejected'>('idle');
  const [warnMsg,   setWarnMsg]   = useState('');
  const [errMsg,    setErrMsg]    = useState('');

  async function act(action: 'approve' | 'reject') {
    setLoading(true);
    setErrMsg('');
    setWarnMsg('');
    try {
      const res = await fetch('/api/admin/requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action,
          email: req.email,
          firstName: firstName.trim(),
          lastName:  lastName.trim(),
          firmName:  firmName.trim(),
          // Empty means "leave whatever they submitted" — the route ignores
          // anything that is not one of the constrained values.
          ...(firmType ? { firmType } : {}),
          ...(firmSize ? { firmSize } : {}),
          ...(trial ? { trial: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));

      let warning = '';
      if (action === 'approve') {
        const data = await res.json().catch(() => ({})) as { emailSent?: boolean; warning?: string };
        warning =
          data.warning ??
          (data.emailSent === false ? 'Invite created, but the email could not be delivered.' : '');
      }

      setStatus(action === 'approve' ? 'approved' : 'rejected');
      if (warning) {
        // Surface it and let the founder dismiss — do not quietly refresh it away.
        setWarnMsg(warning);
      } else {
        setTimeout(onDone, 800);
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (status !== 'idle') {
    return (
      <div className="border border-frame bg-cream px-5 py-4 space-y-2">
        <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>
          {status === 'approved' ? '✓ Invite sent' : 'Rejected'}
        </span>
        {warnMsg && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="text-[11px] text-amber-600 flex-1">{warnMsg}</p>
            <button onClick={onDone} className={ACTION_CLASS} style={{ letterSpacing: '0.1em' }}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border border-frame bg-white">
      <div className="px-5 py-4 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-navy truncate">
              {req.name} <span className="font-normal text-muted">at</span> {req.firm}
            </p>
            <p className="text-xs text-muted truncate">{req.email}</p>
          </div>
          <span className="text-[10px] text-muted shrink-0">{formatDate(req.submittedAt)}</span>
        </div>
        <p className="text-xs text-muted leading-relaxed line-clamp-3" style={{ fontWeight: 300 }}>
          {req.useCase}
        </p>
      </div>

      <div className="border-t border-frame px-5 py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>First name</label>
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>Last name</label>
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>Organization</label>
            <input
              type="text"
              value={firmName}
              onChange={e => setFirmName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </div>
        </div>

        {/* The two answers Matchy turns into a phrase — correctable before approval. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              className={LABEL_CLASS}
              style={{ letterSpacing: '0.12em' }}
              htmlFor={`firm-type-${req.email}`}
            >
              Firm type
            </label>
            <select
              id={`firm-type-${req.email}`}
              value={firmType}
              onChange={e => setFirmType(e.target.value as FirmTypeValue | '')}
              disabled={loading}
              className={SELECT_CLASS}
            >
              <option value="">Not given</option>
              {FIRM_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label
              className={LABEL_CLASS}
              style={{ letterSpacing: '0.12em' }}
              htmlFor={`firm-size-${req.email}`}
            >
              Firm size
            </label>
            <select
              id={`firm-size-${req.email}`}
              value={firmSize}
              onChange={e => setFirmSize(e.target.value as FirmSizeValue | '')}
              disabled={loading}
              className={SELECT_CLASS}
            >
              <option value="">Not given</option>
              {FIRM_SIZE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-[10px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
          These two answers are how Matchy describes the client to an expert — &ldquo;a mid-size PE
          firm&rdquo;. Correct them here if the requester picked badly.
        </p>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={trial}
            onChange={e => setTrial(e.target.checked)}
            disabled={loading || personalDomain}
            className="mt-[2px] shrink-0 accent-navy"
          />
          <span className="text-[11px] text-ink leading-relaxed">
            Trial account — no card at onboarding. They can brief, source and bookmark; nothing reaches
            an expert until a card is added.
            {personalDomain && (
              <span className="block text-[10px] text-muted mt-0.5">
                Personal email address: this can only be approved as a trial, in its own organization.
              </span>
            )}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[10px] text-muted flex-1 min-w-[180px]" style={{ fontWeight: 300 }}>
            {trial
              ? 'Trial: the organization is created without billing. Converting is one card, added by the tester from Settings.'
              : 'The organization is billed per active seat once the first member adds a card.'}
          </p>
          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              onClick={() => act('reject')}
              disabled={loading}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-3 py-1.5 transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.12em' }}
            >
              Reject
            </button>
            <button
              onClick={() => act('approve')}
              disabled={loading || !firstName.trim() || !lastName.trim()}
              className="text-[10px] uppercase tracking-widest px-4 py-1.5 transition-colors disabled:opacity-40"
              style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
            >
              {loading ? 'Sending…' : trial ? 'Approve as Trial + Send Invite' : 'Approve + Send Invite'}
            </button>
          </div>
        </div>

        {errMsg && <p className="text-[11px] text-red-600">{errMsg}</p>}
      </div>
    </div>
  );
}

// ─── Seat request card ────────────────────────────────────────────────────────

function SeatRequestCard({ req, onDone }: { req: SeatRequest; onDone: () => void }) {
  const prefill = splitName(req.name ?? '');

  const [firstName, setFirstName] = useState(prefill.first);
  const [lastName,  setLastName]  = useState(prefill.last);
  const [loading,   setLoading]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [errMsg,    setErrMsg]    = useState('');

  // Name inputs stay visible when the stored request could not supply both.
  const needsName = !prefill.first || !prefill.last;

  async function act(action: 'approve' | 'reject') {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/seat-requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action,
          email: req.email,
          firstName: firstName.trim(),
          lastName:  lastName.trim(),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setDone(true);
      setTimeout(onDone, 800);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="border border-frame bg-cream px-5 py-4">
        <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>Done</span>
      </div>
    );
  }

  return (
    <div className="border border-frame bg-white px-5 py-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy truncate">
            {`${firstName} ${lastName}`.trim() || req.email}
          </p>
          <p className="text-xs text-muted truncate">
            {req.email} · {req.firmName ?? req.firmDomain} · {formatDate(req.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => act('reject')}
            disabled={loading}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-3 py-1.5 transition-colors disabled:opacity-40"
            style={{ letterSpacing: '0.12em' }}
          >
            Reject
          </button>
          <button
            onClick={() => act('approve')}
            disabled={loading || !firstName.trim() || !lastName.trim()}
            className="text-[10px] uppercase tracking-widest px-4 py-1.5 transition-colors disabled:opacity-40"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
          >
            {loading ? 'Sending…' : 'Approve + Invite'}
          </button>
        </div>
      </div>

      {needsName && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>First name</label>
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>Last name</label>
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      )}

      {errMsg && <p className="text-[11px] text-red-600">{errMsg}</p>}
    </div>
  );
}

// ─── Status / role pills ──────────────────────────────────────────────────────

function StatusPill({ status }: { status: UserStatus }) {
  const color =
    status === 'active'  ? 'text-green-700' :
    status === 'pending' ? 'text-amber-600' :
    'text-red-600';
  return (
    <span className={`text-[10px] uppercase tracking-widest font-medium ${color}`} style={{ letterSpacing: '0.1em' }}>
      {status}
    </span>
  );
}

function RolePill({ user }: { user: UserInfo }) {
  const isPlatformAdmin = user.role === 'admin';
  const isOrgAdmin      = user.orgRole === 'org_admin';
  return (
    <span
      className={`text-[10px] px-2 py-0.5 uppercase tracking-widest font-medium whitespace-nowrap ${
        isPlatformAdmin
          ? 'bg-navy text-cream'
          : isOrgAdmin
            ? 'border border-navy text-navy'
            : 'border border-frame text-muted'
      }`}
      style={{ letterSpacing: '0.1em' }}
    >
      {isPlatformAdmin ? 'Platform admin' : isOrgAdmin ? 'Champion' : 'User'}
    </span>
  );
}

// ─── Organization member row ──────────────────────────────────────────────────
// Disable/Enable · Resend invite (pending) or Send reset link (active) · Delete
// behind the same two-step inline confirm the organization row uses.

function MemberRow({ user, onChanged }: { user: UserInfo; onChanged: () => void }) {
  const [busy,          setBusy]          = useState<'' | 'status' | 'link' | 'delete'>('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errMsg,        setErrMsg]        = useState('');
  const [okMsg,         setOkMsg]         = useState('');

  const loading = busy !== '';

  async function toggleStatus() {
    const newStatus: UserStatus = user.status === 'active' ? 'disabled' : 'active';
    setBusy('status');
    setErrMsg('');
    setOkMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: user.email, status: newStatus }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChanged();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  // Same call for both labels: provisionAccountInvite decides between a fresh
  // invitation (pending) and a password-reset link (active).
  async function resend() {
    setBusy('link');
    setErrMsg('');
    setOkMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName:    user.firstName ?? '',
          lastName:     user.lastName ?? '',
          email:        user.email,
          organization: { domain: user.firmDomain, name: user.firmName },
          role:         user.role,
          reinvite:     true,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json() as { emailSent?: boolean; warning?: string };
      setOkMsg(
        data.emailSent === false
          ? (data.warning ?? 'Link created, but the email could not be delivered.')
          : user.status === 'pending' ? 'Invite re-sent.' : 'Reset link sent.',
      );
      onChanged();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  // Permanent delete (confirmed via confirmDelete below, no undo). Hits
  // DELETE /api/admin/users, which cascades the Supabase auth user to
  // profiles + organization_members and re-syncs the org's Stripe seat count.
  async function remove() {
    setBusy('delete');
    setErrMsg('');
    setOkMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: user.email }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="border border-frame bg-cream">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-navy font-medium truncate">{fullName(user)}</p>
          <p className="text-[10px] text-muted truncate">
            {user.email} · {user.orgRole === 'org_admin' ? 'Champion' : 'Member'} · {formatDate(user.createdAt)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3 sm:shrink-0">
          <StatusPill status={user.status} />

          {user.status !== 'pending' && (
            <button
              onClick={toggleStatus}
              disabled={loading}
              className={ACTION_CLASS}
              style={{ letterSpacing: '0.1em' }}
            >
              {busy === 'status' ? '…' : user.status === 'active' ? 'Disable' : 'Enable'}
            </button>
          )}

          {user.status !== 'disabled' && (
            <button
              onClick={resend}
              disabled={loading}
              className={ACTION_CLASS}
              style={{ letterSpacing: '0.1em' }}
              title={
                user.status === 'pending'
                  ? 'Send the invitation link again.'
                  : 'Email this person a password-reset link. Nothing else changes.'
              }
            >
              {busy === 'link' ? '…' : user.status === 'pending' ? 'Resend invite' : 'Send reset link'}
            </button>
          )}

          {confirmDelete ? (
            <>
              <button
                onClick={remove}
                disabled={loading}
                className={CONFIRM_DANGER_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                {busy === 'delete' ? '…' : 'Confirm delete'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={loading}
                className="text-[10px] text-muted hover:text-navy transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => { setConfirmDelete(true); setErrMsg(''); setOkMsg(''); }}
              disabled={loading}
              className={DANGER_CLASS}
              style={{ letterSpacing: '0.1em' }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {confirmDelete && (
        <p className="text-[10px] text-muted px-4 pb-3 leading-relaxed" style={{ fontWeight: 300 }}>
          Deleting {user.email} removes the account permanently and frees its billed seat. This
          cannot be undone.
        </p>
      )}
      {errMsg && <p className="text-[10px] text-red-600 px-4 pb-3">{errMsg}</p>}
      {okMsg  && <p className="text-[10px] text-green-700 px-4 pb-3">{okMsg}</p>}
    </div>
  );
}

// ─── Organization panel (expanded) ────────────────────────────────────────────

function FirmPanel({
  firm,
  onClose,
  onMembersChanged,
}: {
  firm:             FirmInfo;
  onClose:          () => void;
  /** Seat counts and billing live on the firm row, so the firms list is
   *  reloaded after every member action, not just the member list. */
  onMembersChanged: () => void;
}) {
  const domain = firm.domain;

  const [users,       setUsers]       = useState<UserInfo[]>([]);
  const [usersLoad,   setUsersLoad]   = useState(domain !== null);
  const [usersErr,    setUsersErr]    = useState('');
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole,  setInviteRole]  = useState<UserRole>('user');
  const [inviting,    setInviting]    = useState(false);
  const [inviteErr,   setInviteErr]   = useState('');
  const [inviteOk,    setInviteOk]    = useState('');

  const loadUsers = useCallback(() => {
    if (domain === null) {
      setUsers([]);
      setUsersLoad(false);
      return;
    }
    setUsersLoad(true);
    setUsersErr('');
    fetch(`/api/admin/users?domain=${encodeURIComponent(domain)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ users?: UserInfo[] }>;
      })
      .then(d => setUsers(d.users ?? []))
      .catch((e: unknown) => setUsersErr(e instanceof Error ? e.message : 'Failed to load members'))
      .finally(() => setUsersLoad(false));
  }, [domain]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const afterMemberAction = useCallback(() => {
    loadUsers();
    onMembersChanged();
  }, [loadUsers, onMembersChanged]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (inviting || domain === null) return;
    setInviting(true);
    setInviteErr('');
    setInviteOk('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName:    firstName.trim(),
          lastName:     lastName.trim(),
          email:        inviteEmail.trim(),
          organization: { domain, name: firm.name },
          role:         inviteRole,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json() as { emailSent?: boolean };
      setInviteOk(
        data.emailSent === false
          ? 'Invite created, but the email could not be delivered.'
          : `Invite sent to ${inviteEmail.trim()}.`,
      );
      setFirstName('');
      setLastName('');
      setInviteEmail('');
      setInviteRole('user');
      afterMemberAction();
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="border border-navy bg-white mt-1 mb-2">
      <div className="px-5 py-4 border-b border-frame flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy truncate">{firm.name}</p>
          <p className="text-xs text-muted truncate">
            {domain ?? '—'} · {seatSummaryLine(firm)}
          </p>
          <p className="text-xs truncate mt-0.5">
            <BillingLine firm={firm} showEmail />
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors shrink-0"
          style={{ letterSpacing: '0.1em' }}
        >
          Close
        </button>
      </div>

      <div className="px-5 py-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.16em' }}>
          Members
        </p>

        {domain === null ? (
          <p className="text-xs text-muted">
            This organization has no domain, so members cannot be listed or invited here.
          </p>
        ) : usersLoad ? (
          <SkeletonRows count={2} />
        ) : usersErr ? (
          <ErrorBox message={usersErr} onRetry={loadUsers} />
        ) : users.length === 0 ? (
          <p className="text-xs text-muted">No members yet.</p>
        ) : (
          <div className="space-y-2">
            {users.map(u => (
              <MemberRow key={u.email} user={u} onChanged={afterMemberAction} />
            ))}
          </div>
        )}

        {/* Invite member */}
        {domain !== null && (
          <form onSubmit={sendInvite} className="pt-2 space-y-3">
            <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.16em' }}>
              Invite member
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                value={firstName}
                onChange={e => { setFirstName(e.target.value); setInviteOk(''); setInviteErr(''); }}
                placeholder="First name"
                maxLength={100}
                disabled={inviting}
                className={INPUT_CLASS}
                aria-label="First name"
              />
              <input
                type="text"
                value={lastName}
                onChange={e => { setLastName(e.target.value); setInviteOk(''); setInviteErr(''); }}
                placeholder="Last name"
                maxLength={100}
                disabled={inviting}
                className={INPUT_CLASS}
                aria-label="Last name"
              />
              <input
                type="email"
                value={inviteEmail}
                onChange={e => { setInviteEmail(e.target.value); setInviteOk(''); setInviteErr(''); }}
                placeholder={`user@${domain}`}
                disabled={inviting}
                className={INPUT_CLASS}
                aria-label="Email"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  className={LABEL_CLASS}
                  style={{ letterSpacing: '0.12em' }}
                  htmlFor={`invite-role-${firm.id}`}
                >
                  Role
                </label>
                <select
                  id={`invite-role-${firm.id}`}
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as UserRole)}
                  disabled={inviting}
                  className={SELECT_CLASS}
                >
                  <option value="user">User</option>
                  <option value="admin">Platform admin</option>
                </select>
              </div>
            </div>
            <p className="text-[10px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
              Each accepted invite adds a billed seat to this organization. Platform admins count as
              a seat for this organization.
            </p>
            <button
              type="submit"
              disabled={inviting || !firstName.trim() || !lastName.trim() || !inviteEmail.trim()}
              className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
            >
              {inviting ? 'Sending…' : 'Send invite'}
            </button>
            {inviteErr && <p className="text-[11px] text-red-600">{inviteErr}</p>}
            {inviteOk  && <p className="text-[11px] text-green-700">{inviteOk}</p>}
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Organization row ─────────────────────────────────────────────────────────

/** What the sync-seats action reported, rendered under the row. */
interface SyncOutcome {
  tone: 'ok' | 'muted' | 'error';
  text: string;
}

function FirmRow({ firm, onUpdated }: { firm: FirmInfo; onUpdated: () => void }) {
  const [expanded,      setExpanded]      = useState(false);
  const [editing,       setEditing]       = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [capInput,      setCapInput]      = useState(firm.seatLimit === null ? '' : String(firm.seatLimit));
  const [loading,       setLoading]       = useState(false);
  const [syncing,       setSyncing]       = useState(false);
  const [sync,          setSync]          = useState<SyncOutcome | null>(null);
  const [errMsg,        setErrMsg]        = useState('');

  // A background refresh must not leave stale values in the open editor.
  useEffect(() => {
    setCapInput(firm.seatLimit === null ? '' : String(firm.seatLimit));
    setEditing(false);
    setConfirmRemove(false);
    setErrMsg('');
  }, [firm.id, firm.name, firm.seatLimit]);

  // The firms API is addressed by domain, so domain-less orgs are read-only here.
  const domain    = firm.domain;
  const canManage = domain !== null;

  async function save(seatLimit: number | null) {
    if (domain === null) return;
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain, name: firm.name, seatLimit }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setEditing(false);
      onUpdated();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function handleSave() {
    const trimmed = capInput.trim();
    if (!trimmed) return save(null);
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setErrMsg('Seat cap must be a whole number of at least 1, or empty for unlimited.');
      return;
    }
    return save(Math.floor(parsed));
  }

  async function syncSeats() {
    if (domain === null) return;
    setSyncing(true);
    setSync(null);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain, action: 'sync-seats' }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json() as { outcome?: string; activeSeats?: number };
      const seats = data.activeSeats ?? firm.seatUsed;

      if (data.outcome === 'updated') {
        setSync({ tone: 'ok', text: `Synced ${pluralSeats(seats)}.` });
      } else if (data.outcome === 'unchanged') {
        setSync({ tone: 'muted', text: `Already in sync — ${pluralSeats(seats)}.` });
      } else if (data.outcome === 'skipped') {
        setSync({ tone: 'muted', text: 'Nothing to sync — billing not set up.' });
      } else {
        setSync({ tone: 'error', text: 'Stripe refused the seat update. Check the subscription in Stripe.' });
      }
      onUpdated();
    } catch (e) {
      setSync({ tone: 'error', text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setSyncing(false);
    }
  }

  // Permanent org delete (confirmed via confirmRemove below). The API cancels
  // any live Stripe subscription first and refuses the delete (409) if that
  // fails, so this never leaves a canceled org still being billed.
  async function remove() {
    if (domain === null) return;
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setConfirmRemove(false);
      onUpdated();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
      setLoading(false);
    }
  }

  const syncClass =
    sync?.tone === 'ok'    ? 'text-green-700' :
    sync?.tone === 'error' ? 'text-red-600'   :
    'text-muted';

  return (
    <>
      <div className="border border-frame bg-cream">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
          <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left min-w-0">
            <p className="text-xs text-navy font-medium truncate">{firm.name}</p>
            <p className="text-[10px] text-muted truncate">
              {domain ?? '—'} · {seatSummaryLine(firm)}
            </p>
            <p className="text-[10px] truncate mt-0.5">
              <BillingLine firm={firm} />
            </p>
          </button>

          {editing ? (
            <div className="w-full sm:w-auto flex flex-col sm:flex-row sm:items-end gap-2 sm:shrink-0">
              <div className="w-full sm:w-48">
                <label
                  className={LABEL_CLASS}
                  style={{ letterSpacing: '0.12em' }}
                  htmlFor={`seat-cap-${firm.id}`}
                >
                  Seat cap (optional)
                </label>
                <input
                  id={`seat-cap-${firm.id}`}
                  type="number"
                  min={1}
                  value={capInput}
                  onChange={e => setCapInput(e.target.value)}
                  placeholder="Unlimited"
                  disabled={loading}
                  className="w-full text-xs border border-frame bg-white px-2 py-1.5 focus:outline-none focus:border-navy"
                />
                <p className="text-[10px] text-muted mt-1 leading-relaxed" style={{ fontWeight: 300 }}>
                  Blocks new invites above this number. Billing is per active seat regardless.
                </p>
              </div>
              <div className="flex items-center gap-2 pb-0.5">
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="text-[10px] uppercase tracking-widest text-navy border border-navy px-2.5 py-1 transition-colors disabled:opacity-40"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {loading ? '…' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setCapInput(firm.seatLimit === null ? '' : String(firm.seatLimit));
                    setErrMsg('');
                  }}
                  className="text-[10px] text-muted hover:text-navy transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              <button
                onClick={() => setExpanded(v => !v)}
                className={ACTION_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                {expanded ? 'Collapse' : 'Manage'}
              </button>
              <button
                onClick={() => { setConfirmRemove(false); setEditing(true); }}
                disabled={!canManage}
                title={canManage ? 'Set or clear the invite cap for this organization.' : 'This organization has no domain and cannot be edited here.'}
                className={ACTION_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                Seat cap
              </button>
              <button
                onClick={syncSeats}
                disabled={syncing || loading || !canManage}
                title={canManage ? 'Push the current active-seat count to the Stripe subscription.' : 'This organization has no domain and cannot be synced here.'}
                className={ACTION_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                {syncing ? 'Syncing…' : 'Sync seats to Stripe'}
              </button>
              {confirmRemove ? (
                <>
                  <button
                    onClick={remove}
                    disabled={loading}
                    className={CONFIRM_DANGER_CLASS}
                    style={{ letterSpacing: '0.1em' }}
                  >
                    {loading ? '…' : 'Confirm remove'}
                  </button>
                  <button
                    onClick={() => setConfirmRemove(false)}
                    disabled={loading}
                    className="text-[10px] text-muted hover:text-navy transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRemove(true)}
                  disabled={loading || !canManage}
                  title={canManage ? undefined : 'This organization has no domain and cannot be removed here.'}
                  className={DANGER_CLASS}
                  style={{ letterSpacing: '0.1em' }}
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>

        {confirmRemove && !editing && (
          <p className="text-[10px] text-muted px-4 pb-3 leading-relaxed" style={{ fontWeight: 300 }}>
            Removing the organization deletes its memberships; the people keep their sign-in but lose
            access until re-invited. Its Stripe subscription is cancelled first.
          </p>
        )}
        {sync   && <p className={`text-[10px] px-4 pb-3 ${syncClass}`}>{sync.text}</p>}
        {errMsg && <p className="text-[10px] text-red-600 px-4 pb-3">{errMsg}</p>}
      </div>

      {expanded && (
        <FirmPanel
          firm={firm}
          onClose={() => setExpanded(false)}
          onMembersChanged={onUpdated}
        />
      )}
    </>
  );
}

// ─── Trial tester ─────────────────────────────────────────────────────────────

/**
 * One form for the whole trial flow: name + email (+ optional firm name) →
 * POST /api/admin/users { trial: true }. A tester on a personal address lands
 * in a generated organization of their own; a work address forms (or joins)
 * its firm's organization, marked trial. The invite email goes out from here.
 */
function TrialTesterForm({ onDone }: { onDone: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [firmName,  setFirmName]  = useState('');
  const [busy,      setBusy]      = useState(false);
  const [okMsg,     setOkMsg]     = useState('');
  const [errMsg,    setErrMsg]    = useState('');

  const personal = isPublicEmailDomain(email.trim().split('@')[1] ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setOkMsg('');
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName:    firstName.trim(),
          lastName:     lastName.trim(),
          email:        email.trim(),
          organization: firmName.trim() ? { name: firmName.trim() } : {},
          trial:        true,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json().catch(() => ({})) as {
        emailSent?: boolean; warning?: string; organizationDomain?: string; trial?: boolean;
      };
      setOkMsg(
        (data.warning ?? `Trial invite sent to ${email.trim()}.`) +
        (data.organizationDomain ? ` Organization: ${data.organizationDomain}.` : '') +
        (data.trial === false ? ' The trial flag could not be written — check the organization row.' : ''),
      );
      setFirstName(''); setLastName(''); setEmail(''); setFirmName('');
      onDone();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[11px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
        A trial tester behaves like a prospective customer: onboarding without a card, briefs, sourcing,
        anonymized candidates, bookmarks and passes. Nothing reaches an expert, no call is booked and no
        card is charged until they add a card from Settings — that is the conversion.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="trial-first">First name</label>
          <input id="trial-first" type="text" value={firstName} onChange={e => setFirstName(e.target.value)} className={INPUT_CLASS} autoComplete="off" />
        </div>
        <div>
          <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="trial-last">Last name</label>
          <input id="trial-last" type="text" value={lastName} onChange={e => setLastName(e.target.value)} className={INPUT_CLASS} autoComplete="off" />
        </div>
        <div>
          <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="trial-email">Email</label>
          <input id="trial-email" type="email" value={email} onChange={e => setEmail(e.target.value)} className={INPUT_CLASS} autoComplete="off" placeholder="tester@gmail.com" />
        </div>
        <div>
          <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="trial-firm">
            Firm name <span className="normal-case tracking-normal text-muted">(optional)</span>
          </label>
          <input id="trial-firm" type="text" value={firmName} onChange={e => setFirmName(e.target.value)} className={INPUT_CLASS} autoComplete="off" placeholder="Shown to them as their firm" />
        </div>
      </div>
      <p className="text-[10px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
        {personal
          ? 'Personal address: they get their own generated organization (trial-….expertmatch.fit).'
          : email.includes('@')
            ? 'Work address: they form or join their firm\u2019s organization, marked as a trial.'
            : 'Each tester gets a normal account; the trial flag lives on the organization.'}
      </p>
      <button
        type="submit"
        disabled={busy || !firstName.trim() || !lastName.trim() || !email.trim()}
        className="text-[10px] uppercase tracking-widest px-4 py-2 transition-colors disabled:opacity-40"
        style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
      >
        {busy ? 'Sending…' : 'Create trial + send invite'}
      </button>
      {errMsg && <p className="text-[11px] text-red-600">{errMsg}</p>}
      {okMsg  && <p className="text-[11px] text-green-700">{okMsg}</p>}
    </form>
  );
}

// ─── Needs attention ──────────────────────────────────────────────────────────

function AttentionSection() {
  const [items,   setItems]   = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg,  setErrMsg]  = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setErrMsg('');
    fetch('/api/admin/attention')
      .then(async (r) => {
        // The feed is built by another part of the console; until it ships a
        // 404 is "nothing to show", not a broken page.
        if (r.status === 404) return { items: [] };
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ items?: AttentionItem[] }>;
      })
      .then(d => setItems(d.items ?? []))
      .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : 'Failed to load attention items'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section>
      <SectionHeader title="Needs Attention" />

      {loading ? (
        <SkeletonRows count={2} />
      ) : errMsg ? (
        <ErrorBox message={errMsg} onRetry={load} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted py-2">Nothing needs attention.</p>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="border border-frame bg-white px-4 py-3">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest text-amber-600 font-medium" style={{ letterSpacing: '0.12em' }}>
                    {item.kind.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-ink leading-relaxed mt-1">{item.message}</p>
                </div>
                <span className="text-[10px] text-muted shrink-0">{formatTimestamp(item.occurredAt)}</span>
              </div>
              {item.projectId && (
                <Link
                  href={`/projects/${item.projectId}`}
                  className="inline-block mt-2 text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                  style={{ letterSpacing: '0.12em' }}
                >
                  Open project →
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Environment ──────────────────────────────────────────────────────────────

function EnvironmentSection() {
  const [groups,  setGroups]  = useState<EnvGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg,  setErrMsg]  = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setErrMsg('');
    fetch('/api/admin/env-status')
      .then(async (r) => {
        if (r.status === 404) return { groups: [] };
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ groups?: EnvGroup[] }>;
      })
      .then(d => setGroups(d.groups ?? []))
      .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : 'Failed to load environment status'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section>
      <SectionHeader title="Environment" />

      <p className="text-[11px] text-muted mb-4 leading-relaxed" style={{ fontWeight: 300 }}>
        Presence only — no value is ever read back into this page.
      </p>

      {loading ? (
        <SkeletonRows count={2} />
      ) : errMsg ? (
        <ErrorBox message={errMsg} onRetry={load} />
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted py-2">No environment report available.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(group => (
            <div key={group.name} className="border border-frame bg-cream px-4 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted mb-2.5" style={{ letterSpacing: '0.16em' }}>
                {group.name}
              </p>
              {group.vars.some(v => v.optional) && (
                <p className="text-[11px] text-muted mb-2 leading-relaxed" style={{ fontWeight: 300 }}>
                  Feature switches. The app runs without these; a grey dot means the feature is off, not broken.
                </p>
              )}
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {group.vars.map(v => (
                  <li key={v.name} className="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${v.set ? 'bg-green-600' : v.optional ? 'bg-muted/40' : 'bg-red-400'}`}
                    />
                    <span className="text-[11px] text-ink truncate font-mono">{v.name}</span>
                    <span className="sr-only">{v.set ? 'set' : 'not set'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminConsolePage() {
  // Organizations
  const [firms,     setFirms]     = useState<FirmInfo[]>([]);
  const [firmsLoad, setFirmsLoad] = useState(true);
  const [firmsErr,  setFirmsErr]  = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newName,   setNewName]   = useState('');
  const [addCap,    setAddCap]    = useState('');
  const [adding,    setAdding]    = useState(false);
  const [addErr,    setAddErr]    = useState('');

  // Access requests
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [reqLoad,  setReqLoad]  = useState(true);
  const [reqErr,   setReqErr]   = useState('');

  // Seat requests
  const [seatReqs,    setSeatReqs]    = useState<SeatRequest[]>([]);
  const [seatReqLoad, setSeatReqLoad] = useState(true);
  const [seatReqErr,  setSeatReqErr]  = useState('');

  // All users (cross-organization)
  const [users,     setUsers]     = useState<UserInfo[]>([]);
  const [usersLoad, setUsersLoad] = useState(true);
  const [usersErr,  setUsersErr]  = useState('');

  const loadFirms = useCallback(() => {
    setFirmsLoad(true);
    setFirmsErr('');
    fetch('/api/admin/firms')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ firms?: FirmInfo[] }>;
      })
      .then(d => setFirms(d.firms ?? []))
      .catch((e: unknown) => setFirmsErr(e instanceof Error ? e.message : 'Failed to load organizations'))
      .finally(() => setFirmsLoad(false));
  }, []);

  const loadUsers = useCallback(() => {
    setUsersLoad(true);
    setUsersErr('');
    fetch('/api/admin/users?all=true')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ users?: UserInfo[] }>;
      })
      .then((d) => {
        // Platform admins first, then alphabetical by email.
        const sorted = (d.users ?? []).slice().sort((a, b) => {
          if (a.role === 'admin' && b.role !== 'admin') return -1;
          if (a.role !== 'admin' && b.role === 'admin') return  1;
          return a.email.localeCompare(b.email);
        });
        setUsers(sorted);
      })
      .catch((e: unknown) => setUsersErr(e instanceof Error ? e.message : 'Failed to load users'))
      .finally(() => setUsersLoad(false));
  }, []);

  const loadRequests = useCallback(() => {
    setReqLoad(true);
    setReqErr('');
    fetch('/api/admin/requests')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ requests?: AccessRequest[] }>;
      })
      .then(d => setRequests(d.requests ?? []))
      .catch((e: unknown) => setReqErr(e instanceof Error ? e.message : 'Failed to load requests'))
      .finally(() => setReqLoad(false));
  }, []);

  const loadSeatRequests = useCallback(() => {
    setSeatReqLoad(true);
    setSeatReqErr('');
    fetch('/api/admin/seat-requests')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ requests?: SeatRequest[] }>;
      })
      .then(d => setSeatReqs(d.requests ?? []))
      .catch((e: unknown) => setSeatReqErr(e instanceof Error ? e.message : 'Failed to load seat requests'))
      .finally(() => setSeatReqLoad(false));
  }, []);

  useEffect(() => {
    loadRequests();
    loadSeatRequests();
    loadFirms();
    loadUsers();
  }, [loadFirms, loadRequests, loadSeatRequests, loadUsers]);

  /** Approving anything creates an organization and an account — reload both. */
  const afterProvisioning = useCallback(() => {
    loadRequests();
    loadFirms();
    loadUsers();
  }, [loadFirms, loadRequests, loadUsers]);

  const afterSeatRequest = useCallback(() => {
    loadSeatRequests();
    loadFirms();
    loadUsers();
  }, [loadFirms, loadSeatRequests, loadUsers]);

  /** A member action changes seat counts, billing and the cross-org list. */
  const afterMemberChange = useCallback(() => {
    loadFirms();
    loadUsers();
  }, [loadFirms, loadUsers]);

  async function addFirm(e: React.FormEvent) {
    e.preventDefault();
    if (!newDomain.trim() || !newName.trim() || adding) return;

    const trimmedCap = addCap.trim();
    let seatLimit: number | null = null;
    if (trimmedCap) {
      const parsed = Number(trimmedCap);
      if (!Number.isFinite(parsed) || parsed < 1) {
        setAddErr('Seat cap must be a whole number of at least 1, or empty for unlimited.');
        return;
      }
      seatLimit = Math.floor(parsed);
    }

    setAdding(true);
    setAddErr('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          domain: newDomain.trim(),
          name:   newName.trim(),
          seatLimit,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setNewDomain('');
      setNewName('');
      setAddCap('');
      loadFirms();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setAdding(false);
    }
  }

  const userCount = users.length;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-5">
            <span
              className="text-[10px] uppercase tracking-widest text-gold/80"
              style={{ letterSpacing: '0.18em' }}
            >
              Admin
            </span>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-14">

        {/* ── 1. Pending access requests ── */}
        <section>
          <SectionHeader title="Pending Requests" />

          {reqLoad ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="border border-frame bg-white px-5 py-4 space-y-2">
                  <div className="h-4 w-1/3 bg-frame rounded animate-pulse" />
                  <div className="h-3 w-2/3 bg-frame rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : reqErr ? (
            <ErrorBox message={reqErr} onRetry={loadRequests} />
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending access requests.</p>
          ) : (
            <div className="space-y-3">
              {requests.map(req => (
                <AccessRequestCard key={req.email} req={req} onDone={afterProvisioning} />
              ))}
            </div>
          )}
        </section>

        {/* ── Seat requests — only when a capped organization has one waiting ── */}
        {seatReqLoad ? null : seatReqErr ? (
          <section>
            <SectionHeader title="Seat Requests" />
            <ErrorBox message={seatReqErr} onRetry={loadSeatRequests} />
          </section>
        ) : seatReqs.length > 0 ? (
          <section>
            <SectionHeader title="Seat Requests" />
            <div className="space-y-3">
              {seatReqs.map(req => (
                <SeatRequestCard key={req.email} req={req} onDone={afterSeatRequest} />
              ))}
            </div>
          </section>
        ) : null}

        {/* ── 2. Needs attention ── */}
        <AttentionSection />

        {/* ── 3. Organizations ── */}
        <section>
          <SectionHeader title="Organizations" />

          <p className="text-[11px] text-muted mb-4 leading-relaxed" style={{ fontWeight: 300 }}>
            Every organization is billed per active seat at its volume tier. The subscription is created
            automatically when the first member adds a card during onboarding.
          </p>

          {firmsLoad ? (
            <SkeletonRows count={2} />
          ) : firmsErr ? (
            <ErrorBox message={firmsErr} onRetry={loadFirms} />
          ) : firms.length === 0 ? (
            <p className="text-sm text-muted">No organizations yet.</p>
          ) : (
            <div className="space-y-2">
              {firms.map(f => (
                <FirmRow key={f.id} firm={f} onUpdated={afterMemberChange} />
              ))}
            </div>
          )}
        </section>

        {/* ── 3b. Provision a trial tester ── */}
        <section>
          <SectionHeader title="Provision Trial Tester" />
          <TrialTesterForm onDone={afterMemberChange} />
        </section>

        {/* ── 4. Add organization ── */}
        <section>
          <SectionHeader title="Add Organization" />

          <form onSubmit={addFirm} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="new-firm-domain">Domain</label>
                <input
                  id="new-firm-domain"
                  type="text"
                  value={newDomain}
                  onChange={e => { setNewDomain(e.target.value); setAddErr(''); }}
                  placeholder="blackstone.com"
                  disabled={adding}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="new-firm-name">Name</label>
                <input
                  id="new-firm-name"
                  type="text"
                  value={newName}
                  onChange={e => { setNewName(e.target.value); setAddErr(''); }}
                  placeholder="Blackstone"
                  maxLength={100}
                  disabled={adding}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }} htmlFor="new-firm-cap">Seat cap (optional)</label>
                <input
                  id="new-firm-cap"
                  type="number"
                  min={1}
                  value={addCap}
                  onChange={e => { setAddCap(e.target.value); setAddErr(''); }}
                  placeholder="Unlimited"
                  disabled={adding}
                  className={INPUT_CLASS}
                />
                <p className="text-[10px] text-muted mt-1 leading-relaxed" style={{ fontWeight: 300 }}>
                  Blocks new invites above this number. Billing is per active seat regardless.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={!newDomain.trim() || !newName.trim() || adding}
                className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
              >
                {adding ? 'Adding…' : 'Add organization'}
              </button>
              {addErr && <p className="text-[11px] text-red-600">{addErr}</p>}
            </div>
          </form>
        </section>

        {/* ── 5. All users ── */}
        <section>
          <SectionHeader title={`All Users${userCount > 0 ? ` (${userCount})` : ''}`} />

          <p className="text-[11px] text-muted mb-4 leading-relaxed" style={{ fontWeight: 300 }}>
            Every account across every organization. Invite, disable and delete from the
            organization&rsquo;s own panel above — that is where seat counts and billing follow along.
          </p>

          {usersLoad ? (
            <SkeletonRows count={3} />
          ) : usersErr ? (
            <ErrorBox message={usersErr} onRetry={loadUsers} />
          ) : users.length === 0 ? (
            <p className="text-sm text-muted py-2">
              No users yet. Add an organization, then invite its first member.
            </p>
          ) : (
            <div className="space-y-2">
              {users.map(u => (
                <div
                  key={u.email}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3 border border-frame bg-cream"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-navy font-medium truncate">{fullName(u)}</p>
                    <p className="text-[10px] text-muted truncate">
                      {u.email}
                      {' · '}
                      {u.firmName || u.firmDomain || (u.role === 'admin' ? 'ExpertMatch' : '—')}
                      {' · '}
                      {formatDate(u.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <RolePill user={u} />
                    <StatusPill status={u.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 6. Environment ── */}
        <EnvironmentSection />

      </main>
    </div>
  );
}
