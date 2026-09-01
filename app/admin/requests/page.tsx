'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatUsdFromCents } from '../../../lib/pricing';

// ─── Types ────────────────────────────────────────────────────────────────────

type FirmPlan   = 'starter' | 'growth' | 'enterprise';
type FirmStatus = 'active' | 'disabled';
type UserStatus = 'active' | 'pending' | 'disabled';

interface FirmInfo {
  id:                     string;
  domain:                 string;
  name:                   string;
  plan:                   FirmPlan;
  status:                 FirmStatus;
  createdAt:              number;
  seatUsed:               number;
  seatPending:            number;
  seatLimit:              number | null;   // null = unlimited
  seatUnitPriceCents:     number;
  monthlySeatTotalCents:  number;
}

interface UserInfo {
  email:      string;
  role:       'admin' | 'user';
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

// ─── Constants + helpers ──────────────────────────────────────────────────────

const PLAN_LABELS: Record<FirmPlan, string> = {
  starter:    'Starter',
  growth:     'Growth',
  enterprise: 'Enterprise',
};

const PLAN_OPTIONS = Object.entries(PLAN_LABELS) as [FirmPlan, string][];

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Jane Q. Okafor" → { first: 'Jane', last: 'Q. Okafor' } */
function splitName(fullName: string): { first: string; last: string } {
  const clean = (fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { first: '', last: '' };
  const parts = clean.split(' ');
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function seatSummaryLine(firm: FirmInfo): string {
  const cap = firm.seatLimit === null ? 'no cap' : `cap ${firm.seatLimit}`;
  return `${firm.seatUsed} seat${firm.seatUsed === 1 ? '' : 's'} · ${formatUsdFromCents(firm.seatUnitPriceCents)}/seat · ${formatUsdFromCents(firm.monthlySeatTotalCents)}/mo · ${cap}`;
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
const LABEL_CLASS = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';
const ACTION_CLASS =
  'text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0';

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

// ─── Access request card ──────────────────────────────────────────────────────

function AccessRequestCard({ req, onDone }: { req: AccessRequest; onDone: () => void }) {
  const prefill = splitName(req.name);

  const [firstName, setFirstName] = useState(prefill.first);
  const [lastName,  setLastName]  = useState(prefill.last);
  const [firmName,  setFirmName]  = useState(req.firm);
  const [plan,      setPlan]      = useState<FirmPlan>('starter');
  const [loading,   setLoading]   = useState(false);
  const [status,    setStatus]    = useState<'idle' | 'approved' | 'rejected'>('idle');
  const [errMsg,    setErrMsg]    = useState('');

  async function act(action: 'approve' | 'reject') {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action,
          email: req.email,
          plan,
          firstName: firstName.trim(),
          lastName:  lastName.trim(),
          firmName:  firmName.trim(),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setStatus(action === 'approve' ? 'approved' : 'rejected');
      setTimeout(onDone, 800);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (status !== 'idle') {
    return (
      <div className="border border-frame bg-cream px-5 py-4">
        <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>
          {status === 'approved' ? '✓ Invite sent' : 'Rejected'}
        </span>
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

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.12em' }}>
              Plan
            </label>
            <select
              value={plan}
              onChange={e => setPlan(e.target.value as FirmPlan)}
              disabled={loading}
              className="text-xs border border-frame bg-cream px-2 py-1.5 text-navy focus:outline-none focus:border-navy"
            >
              {PLAN_OPTIONS.map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

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
              {loading ? 'Sending…' : 'Approve + Send Invite'}
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

// ─── User row ─────────────────────────────────────────────────────────────────

function UserRow({ user, onUpdated }: { user: UserInfo; onUpdated: () => void }) {
  const [loading, setLoading] = useState(false);
  const [errMsg,  setErrMsg]  = useState('');

  async function toggleStatus() {
    const newStatus: UserStatus = user.status === 'active' ? 'disabled' : 'active';
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: user.email, status: newStatus }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onUpdated();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  const statusColor =
    user.status === 'active'   ? 'text-green-700' :
    user.status === 'pending'  ? 'text-amber-600' :
    'text-red-600';

  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 border border-frame bg-cream">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-navy font-medium truncate">{name || user.email}</p>
        <p className="text-[10px] text-muted truncate">
          {user.email} · {user.orgRole === 'org_admin' ? 'Org admin' : 'Member'} · {formatDate(user.createdAt)}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-[10px] uppercase tracking-widest font-medium ${statusColor}`} style={{ letterSpacing: '0.1em' }}>
          {user.status}
        </span>
        {errMsg && <span className="text-[10px] text-red-600 max-w-[160px] truncate">{errMsg}</span>}
        {user.status !== 'pending' && (
          <button
            onClick={toggleStatus}
            disabled={loading}
            className={ACTION_CLASS}
            style={{ letterSpacing: '0.1em' }}
          >
            {loading ? '…' : user.status === 'active' ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Organization panel (expanded) ────────────────────────────────────────────

function FirmPanel({ firm, onClose }: { firm: FirmInfo; onClose: () => void }) {
  const [users,       setUsers]       = useState<UserInfo[]>([]);
  const [usersLoad,   setUsersLoad]   = useState(true);
  const [usersErr,    setUsersErr]    = useState('');
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [inviteErr,   setInviteErr]   = useState('');
  const [inviteOk,    setInviteOk]    = useState('');

  const loadUsers = useCallback(() => {
    setUsersLoad(true);
    setUsersErr('');
    fetch(`/api/admin/users?domain=${encodeURIComponent(firm.domain)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ users?: UserInfo[] }>;
      })
      .then(d => setUsers(d.users ?? []))
      .catch((e: unknown) => setUsersErr(e instanceof Error ? e.message : 'Failed to load members'))
      .finally(() => setUsersLoad(false));
  }, [firm.domain]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (inviting) return;
    setInviting(true);
    setInviteErr('');
    setInviteOk('');
    try {
      const res = await fetch('/api/admin/invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName:    firstName.trim(),
          lastName:     lastName.trim(),
          email:        inviteEmail.trim(),
          organization: { domain: firm.domain, name: firm.name },
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
      loadUsers();
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
            {firm.domain} · {PLAN_LABELS[firm.plan]} · {seatSummaryLine(firm)}
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

        {usersLoad ? (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <div key={i} className="border border-frame bg-cream px-4 py-3">
                <div className="h-3 w-1/2 bg-frame rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : usersErr ? (
          <div className="border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-xs text-red-600">{usersErr}</p>
            <button
              onClick={loadUsers}
              className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700"
              style={{ letterSpacing: '0.12em' }}
            >
              Retry
            </button>
          </div>
        ) : users.length === 0 ? (
          <p className="text-xs text-muted">No members yet.</p>
        ) : (
          <div className="space-y-2">
            {users.map(u => (
              <UserRow key={u.email} user={u} onUpdated={loadUsers} />
            ))}
          </div>
        )}

        {/* Invite member */}
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
              placeholder={`user@${firm.domain}`}
              disabled={inviting}
              className={INPUT_CLASS}
              aria-label="Email"
            />
          </div>
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
      </div>
    </div>
  );
}

// ─── Organization row ─────────────────────────────────────────────────────────

function FirmRow({ firm, onUpdated }: { firm: FirmInfo; onUpdated: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing,  setEditing]  = useState(false);
  const [plan,     setPlan]     = useState<FirmPlan>(firm.plan);
  const [capInput, setCapInput] = useState(firm.seatLimit === null ? '' : String(firm.seatLimit));
  const [loading,  setLoading]  = useState(false);
  const [errMsg,   setErrMsg]   = useState('');

  async function save(seatLimit: number | null) {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: firm.domain, name: firm.name, plan, seatLimit }),
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

  async function remove() {
    if (!confirm(`Remove ${firm.domain}? Members keep their accounts but lose the organization record.`)) return;
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: firm.domain }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onUpdated();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
      setLoading(false);
    }
  }

  return (
    <>
      <div className="border border-frame bg-cream">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
          <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left min-w-0">
            <p className="text-xs text-navy font-medium truncate">{firm.name}</p>
            <p className="text-[10px] text-muted truncate">
              {firm.domain} · {PLAN_LABELS[firm.plan]} · {seatSummaryLine(firm)}
              {firm.seatPending > 0 ? ` · ${firm.seatPending} pending` : ''}
            </p>
          </button>

          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={plan}
                onChange={e => setPlan(e.target.value as FirmPlan)}
                disabled={loading}
                className="text-xs border border-frame bg-white px-2 py-1 focus:outline-none focus:border-navy"
                aria-label="Plan"
              >
                {PLAN_OPTIONS.map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={capInput}
                onChange={e => setCapInput(e.target.value)}
                placeholder="Seat cap (blank = unlimited)"
                disabled={loading}
                className="text-xs border border-frame bg-white px-2 py-1 w-44 focus:outline-none focus:border-navy"
                aria-label="Seat cap"
              />
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
                  setPlan(firm.plan);
                  setCapInput(firm.seatLimit === null ? '' : String(firm.seatLimit));
                  setErrMsg('');
                }}
                className="text-[10px] text-muted hover:text-navy transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                onClick={() => setExpanded(v => !v)}
                className={ACTION_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                {expanded ? 'Collapse' : 'Manage'}
              </button>
              <button
                onClick={() => setEditing(true)}
                className={ACTION_CLASS}
                style={{ letterSpacing: '0.1em' }}
              >
                Plan + cap
              </button>
              <button
                onClick={remove}
                disabled={loading}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
                style={{ letterSpacing: '0.1em' }}
              >
                Remove
              </button>
            </div>
          )}
        </div>
        {errMsg && <p className="text-[10px] text-red-600 px-4 pb-3">{errMsg}</p>}
      </div>

      {expanded && <FirmPanel firm={firm} onClose={() => setExpanded(false)} />}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminRequestsPage() {
  // Organizations
  const [firms,     setFirms]     = useState<FirmInfo[]>([]);
  const [firmsLoad, setFirmsLoad] = useState(true);
  const [firmsErr,  setFirmsErr]  = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newName,   setNewName]   = useState('');
  const [addPlan,   setAddPlan]   = useState<FirmPlan>('starter');
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
    loadFirms();
    loadRequests();
    loadSeatRequests();
  }, [loadFirms, loadRequests, loadSeatRequests]);

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
          plan:   addPlan,
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
              Organizations
            </span>
            <Link
              href="/admin/users"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Users
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-14">

        {/* ── Section 1: Organizations ── */}
        <section>
          <SectionHeader title="Organizations" />

          <p className="text-[11px] text-muted mb-4 leading-relaxed" style={{ fontWeight: 300 }}>
            Every organization is billed per active seat at its volume tier. A seat cap is optional —
            leave it blank for unlimited.
          </p>

          {firmsLoad ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="border border-frame bg-cream px-4 py-3">
                  <div className="h-3.5 w-1/3 bg-frame rounded animate-pulse mb-1.5" />
                  <div className="h-2.5 w-1/2 bg-frame rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : firmsErr ? (
            <div className="border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs text-red-600">{firmsErr}</p>
              <button
                onClick={loadFirms}
                className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700"
                style={{ letterSpacing: '0.12em' }}
              >
                Retry
              </button>
            </div>
          ) : firms.length === 0 ? (
            <p className="text-sm text-muted mb-4">No organizations yet.</p>
          ) : (
            <div className="space-y-2 mb-6">
              {firms.map(f => (
                <FirmRow key={f.domain} firm={f} onUpdated={loadFirms} />
              ))}
            </div>
          )}

          {/* Add organization */}
          <form onSubmit={addFirm} className="mt-4 space-y-3">
            <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.16em' }}>
              Add organization
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>Domain</label>
                <input
                  type="text"
                  value={newDomain}
                  onChange={e => { setNewDomain(e.target.value); setAddErr(''); }}
                  placeholder="blackstone.com"
                  disabled={adding}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>Name</label>
                <input
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
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>Plan</label>
                <select
                  value={addPlan}
                  onChange={e => setAddPlan(e.target.value as FirmPlan)}
                  disabled={adding}
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy"
                >
                  {PLAN_OPTIONS.map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>Seat cap (optional)</label>
                <input
                  type="number"
                  min={1}
                  value={addCap}
                  onChange={e => { setAddCap(e.target.value); setAddErr(''); }}
                  placeholder="Unlimited"
                  disabled={adding}
                  className={INPUT_CLASS}
                />
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

        {/* ── Section 2: Pending Access Requests ── */}
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
            <div className="border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs text-red-600">{reqErr}</p>
              <button
                onClick={loadRequests}
                className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700"
                style={{ letterSpacing: '0.12em' }}
              >
                Retry
              </button>
            </div>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending access requests.</p>
          ) : (
            <div className="space-y-3">
              {requests.map(req => (
                <AccessRequestCard key={req.email} req={req} onDone={loadRequests} />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 3: Seat Requests ── */}
        <section>
          <SectionHeader title="Seat Requests" />

          {seatReqLoad ? (
            <div className="space-y-2">
              {[1].map(i => (
                <div key={i} className="border border-frame bg-white px-5 py-4">
                  <div className="h-4 w-1/3 bg-frame rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : seatReqErr ? (
            <div className="border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs text-red-600">{seatReqErr}</p>
              <button
                onClick={loadSeatRequests}
                className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700"
                style={{ letterSpacing: '0.12em' }}
              >
                Retry
              </button>
            </div>
          ) : seatReqs.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending seat requests.</p>
          ) : (
            <div className="space-y-3">
              {seatReqs.map(req => (
                <SeatRequestCard key={req.email} req={req} onDone={loadSeatRequests} />
              ))}
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
