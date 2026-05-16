'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

type FirmPlan   = 'starter' | 'growth' | 'enterprise';
type FirmStatus = 'active' | 'disabled';
type UserStatus = 'active' | 'pending' | 'disabled';

interface FirmInfo {
  domain:    string;
  name:      string;
  plan:      FirmPlan;
  status:    FirmStatus;
  createdAt: number;
  seatUsed:  number;
  seatLimit: number | null;
}

interface UserInfo {
  email:      string;
  role:       'admin' | 'user';
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
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PLAN_LABELS: Record<FirmPlan, string> = {
  starter:    'Starter — 3 seats',
  growth:     'Growth — 10 seats',
  enterprise: 'Enterprise — unlimited',
};

const PLAN_OPTIONS = Object.entries(PLAN_LABELS) as [FirmPlan, string][];

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

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
  const [plan,    setPlan]    = useState<FirmPlan>('starter');
  const [loading, setLoading] = useState(false);
  const [status,  setStatus]  = useState<'idle' | 'approved' | 'rejected' | 'error'>('idle');
  const [errMsg,  setErrMsg]  = useState('');

  async function act(action: 'approve' | 'reject') {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action, email: req.email, plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setStatus(action === 'approve' ? 'approved' : 'rejected');
      setTimeout(onDone, 800);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
      setStatus('error');
    } finally {
      setLoading(false);
    }
  }

  if (status === 'approved') {
    return (
      <div className="border border-frame bg-cream px-5 py-4 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>
          ✓ Invite sent
        </span>
      </div>
    );
  }

  if (status === 'rejected') {
    return (
      <div className="border border-frame bg-cream px-5 py-4">
        <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>
          Rejected
        </span>
      </div>
    );
  }

  return (
    <div className="border border-frame bg-white">
      <div className="px-5 py-4 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-navy">
              {req.name} <span className="font-normal text-muted">at</span> {req.firm}
            </p>
            <p className="text-xs text-muted">{req.email}</p>
          </div>
          <span className="text-[10px] text-muted shrink-0">{formatDate(req.submittedAt)}</span>
        </div>
        <p className="text-xs text-muted leading-relaxed line-clamp-3" style={{ fontWeight: 300 }}>
          {req.useCase}
        </p>
      </div>
      <div className="border-t border-frame px-5 py-3 flex flex-wrap items-center gap-3">
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
        <div className="flex items-center gap-2 ml-auto">
          {status === 'error' && (
            <span className="text-[10px] text-red-600">{errMsg}</span>
          )}
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
            disabled={loading}
            className="text-[10px] uppercase tracking-widest px-4 py-1.5 transition-colors disabled:opacity-40"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
          >
            {loading ? 'Sending…' : 'Approve + Send Invite'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Seat request card ────────────────────────────────────────────────────────

function SeatRequestCard({ req, onDone }: { req: SeatRequest; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);
  const [errMsg,  setErrMsg]  = useState('');

  async function act(action: 'approve' | 'reject') {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/seat-requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action, email: req.email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Request failed');
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
    <div className="border border-frame bg-white">
      <div className="px-5 py-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-navy">{req.email}</p>
          <p className="text-xs text-muted">{req.firmDomain} · {formatDate(req.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {errMsg && <span className="text-[10px] text-red-600">{errMsg}</span>}
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
            disabled={loading}
            className="text-[10px] uppercase tracking-widest px-4 py-1.5 transition-colors disabled:opacity-40"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
          >
            {loading ? 'Sending…' : 'Approve + Invite'}
          </button>
        </div>
      </div>
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
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

  return (
    <div className="flex items-center gap-4 px-4 py-3 border border-frame bg-cream">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-navy font-medium truncate">{user.email}</p>
        <p className="text-[10px] text-muted capitalize">{user.role} · {formatDate(user.createdAt)}</p>
      </div>
      <span className={`text-[10px] uppercase tracking-widest font-medium ${statusColor}`} style={{ letterSpacing: '0.1em' }}>
        {user.status}
      </span>
      {errMsg && <span className="text-[10px] text-red-600">{errMsg}</span>}
      {user.status !== 'pending' && (
        <button
          onClick={toggleStatus}
          disabled={loading}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
          style={{ letterSpacing: '0.1em' }}
        >
          {loading ? '…' : user.status === 'active' ? 'Disable' : 'Enable'}
        </button>
      )}
    </div>
  );
}

// ─── Firm panel (expanded) ────────────────────────────────────────────────────

function FirmPanel({ firm, onClose, onFirmUpdated }: {
  firm:           FirmInfo;
  onClose:        () => void;
  onFirmUpdated:  () => void;
}) {
  const [users,       setUsers]       = useState<UserInfo[]>([]);
  const [usersLoad,   setUsersLoad]   = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [inviteErr,   setInviteErr]   = useState('');
  const [inviteOk,    setInviteOk]    = useState(false);

  const loadUsers = useCallback(() => {
    setUsersLoad(true);
    fetch(`/api/admin/users?domain=${encodeURIComponent(firm.domain)}`)
      .then(r => r.json())
      .then(d => setUsers(d.users ?? []))
      .catch(() => {})
      .finally(() => setUsersLoad(false));
  }, [firm.domain]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setInviteErr('');
    setInviteOk(false);
    try {
      const res = await fetch('/api/admin/invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: inviteEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Failed to send invite');
      setInviteOk(true);
      setInviteEmail('');
      loadUsers();
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setInviting(false);
    }
  }

  const seatDisplay = firm.seatLimit === null
    ? `${firm.seatUsed} / ∞`
    : `${firm.seatUsed} / ${firm.seatLimit}`;

  return (
    <div className="border border-navy bg-white mt-1 mb-2">
      <div className="px-5 py-4 border-b border-frame flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-navy">{firm.name}</p>
          <p className="text-xs text-muted">{firm.domain} · {firm.plan} plan · {seatDisplay} seats</p>
        </div>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
          style={{ letterSpacing: '0.1em' }}
        >
          Close
        </button>
      </div>

      <div className="px-5 py-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.16em' }}>
          Users
        </p>

        {usersLoad ? (
          <div className="space-y-2">
            {[1, 2].map(i => (
              <div key={i} className="border border-frame bg-cream px-4 py-3">
                <div className="h-3 w-1/2 bg-frame rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : users.length === 0 ? (
          <p className="text-xs text-muted">No users yet.</p>
        ) : (
          <div className="space-y-2">
            {users.map(u => (
              <UserRow key={u.email} user={u} onUpdated={loadUsers} />
            ))}
          </div>
        )}

        {/* Invite user form */}
        <form onSubmit={sendInvite} className="flex items-end gap-3 pt-2">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
              Invite User
            </label>
            <input
              type="email"
              value={inviteEmail}
              onChange={e => { setInviteEmail(e.target.value); setInviteOk(false); setInviteErr(''); }}
              placeholder={`user@${firm.domain}`}
              className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
              disabled={inviting}
            />
          </div>
          <button
            type="submit"
            disabled={!inviteEmail.trim() || inviting}
            className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
          >
            {inviting ? 'Sending…' : 'Invite'}
          </button>
        </form>
        {inviteErr && <p className="text-[11px] text-red-600">{inviteErr}</p>}
        {inviteOk  && <p className="text-[11px] text-green-700">Invite sent.</p>}
      </div>
    </div>
  );
}

// ─── Firm row ─────────────────────────────────────────────────────────────────

function FirmRow({ firm, onUpdated }: { firm: FirmInfo; onUpdated: () => void }) {
  const [expanded,  setExpanded]  = useState(false);
  const [editPlan,  setEditPlan]  = useState(false);
  const [plan,      setPlan]      = useState<FirmPlan>(firm.plan);
  const [loading,   setLoading]   = useState(false);
  const [errMsg,    setErrMsg]    = useState('');

  const seatDisplay = firm.seatLimit === null
    ? `${firm.seatUsed} / ∞`
    : `${firm.seatUsed} / ${firm.seatLimit}`;

  async function savePlan() {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: firm.domain, name: firm.name, plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setEditPlan(false);
      onUpdated();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${firm.domain}?`)) return;
    setLoading(true);
    try {
      await fetch('/api/admin/firms', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: firm.domain }),
      });
      onUpdated();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="border border-frame bg-cream">
        <div className="flex items-center gap-4 px-4 py-3">
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex-1 text-left"
          >
            <p className="text-xs text-navy font-medium">{firm.domain}</p>
            <p className="text-[10px] text-muted">{firm.name}</p>
          </button>

          {editPlan ? (
            <select
              value={plan}
              onChange={e => setPlan(e.target.value as FirmPlan)}
              className="text-xs border border-frame bg-white px-2 py-1 focus:outline-none focus:border-navy"
            >
              {PLAN_OPTIONS.map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-muted capitalize">{firm.plan} plan</span>
          )}

          <span className="text-[11px] text-muted">{seatDisplay} seats</span>

          {errMsg && <span className="text-[10px] text-red-600">{errMsg}</span>}

          <div className="flex items-center gap-2 shrink-0">
            {editPlan ? (
              <>
                <button
                  onClick={savePlan}
                  disabled={loading}
                  className="text-[10px] uppercase tracking-widest text-navy border border-navy px-2.5 py-1 transition-colors disabled:opacity-40"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditPlan(false); setPlan(firm.plan); }}
                  className="text-[10px] text-muted hover:text-navy transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {expanded ? 'Collapse' : 'Manage'}
                </button>
                <button
                  onClick={() => setEditPlan(true)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Plan
                </button>
                <button
                  onClick={remove}
                  disabled={loading}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <FirmPanel
          firm={firm}
          onClose={() => setExpanded(false)}
          onFirmUpdated={onUpdated}
        />
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminRequestsPage() {
  // Firms
  const [firms,     setFirms]     = useState<FirmInfo[]>([]);
  const [firmsLoad, setFirmsLoad] = useState(true);
  const [newDomain, setNewDomain] = useState('');
  const [newName,   setNewName]   = useState('');
  const [addPlan,   setAddPlan]   = useState<FirmPlan>('starter');
  const [adding,    setAdding]    = useState(false);
  const [addErr,    setAddErr]    = useState('');

  // Access requests
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [reqLoad,  setReqLoad]  = useState(true);

  // Seat requests
  const [seatReqs,     setSeatReqs]     = useState<SeatRequest[]>([]);
  const [seatReqLoad,  setSeatReqLoad]  = useState(true);

  const loadFirms = useCallback(() => {
    setFirmsLoad(true);
    fetch('/api/admin/firms')
      .then(r => r.json())
      .then(d => setFirms(d.firms ?? []))
      .catch(() => {})
      .finally(() => setFirmsLoad(false));
  }, []);

  const loadRequests = useCallback(() => {
    setReqLoad(true);
    fetch('/api/admin/requests')
      .then(r => r.json())
      .then(d => setRequests(d.requests ?? []))
      .catch(() => {})
      .finally(() => setReqLoad(false));
  }, []);

  const loadSeatRequests = useCallback(() => {
    setSeatReqLoad(true);
    fetch('/api/admin/seat-requests')
      .then(r => r.json())
      .then(d => setSeatReqs(d.requests ?? []))
      .catch(() => {})
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
    setAdding(true);
    setAddErr('');
    try {
      const res = await fetch('/api/admin/firms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: newDomain.trim(), name: newName.trim(), plan: addPlan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add firm');
      setNewDomain('');
      setNewName('');
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
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link
            href="/app"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <span
            className="text-[10px] uppercase tracking-widest text-gold/70"
            style={{ letterSpacing: '0.18em' }}
          >
            Admin
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-14">

        {/* ── Section 1: Firms ── */}
        <section>
          <SectionHeader title="Firms" />

          {firmsLoad ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="border border-frame bg-cream px-4 py-3">
                  <div className="h-3.5 w-1/3 bg-frame rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : firms.length === 0 ? (
            <p className="text-sm text-muted mb-4">No firms yet.</p>
          ) : (
            <div className="space-y-2 mb-6">
              {firms.map(f => (
                <FirmRow key={f.domain} firm={f} onUpdated={loadFirms} />
              ))}
            </div>
          )}

          {/* Add firm form */}
          <form onSubmit={addFirm} className="mt-4 space-y-3">
            <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.16em' }}>
              Add Firm
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                  Domain
                </label>
                <input
                  type="text"
                  value={newDomain}
                  onChange={e => setNewDomain(e.target.value)}
                  placeholder="blackstone.com"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                  Firm Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Blackstone"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                  Plan
                </label>
                <select
                  value={addPlan}
                  onChange={e => setAddPlan(e.target.value as FirmPlan)}
                  className="border border-frame bg-cream px-2.5 py-2.5 text-xs text-ink focus:outline-none focus:border-navy"
                  disabled={adding}
                >
                  {PLAN_OPTIONS.map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={!newDomain.trim() || !newName.trim() || adding}
                className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
              >
                {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
            {addErr && <p className="text-[11px] text-red-600">{addErr}</p>}
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
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending access requests.</p>
          ) : (
            <div className="space-y-3">
              {requests.map(req => (
                <AccessRequestCard
                  key={req.email}
                  req={req}
                  onDone={loadRequests}
                />
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
          ) : seatReqs.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending seat requests.</p>
          ) : (
            <div className="space-y-3">
              {seatReqs.map(req => (
                <SeatRequestCard
                  key={req.email}
                  req={req}
                  onDone={loadSeatRequests}
                />
              ))}
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
