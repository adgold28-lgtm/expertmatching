'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type FirmPlan = 'starter' | 'growth' | 'enterprise';

interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  submittedAt: number;
}

interface DomainInfo {
  domain:    string;
  plan:      FirmPlan;
  seatLimit: number | null;
  seatUsed:  number;
}

const PLAN_LABELS: Record<FirmPlan, string> = {
  starter:    'Starter — 3 seats',
  growth:     'Growth — 10 seats',
  enterprise: 'Enterprise — unlimited',
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Request card ─────────────────────────────────────────────────────────────

function RequestCard({
  req,
  onDone,
}: {
  req:    AccessRequest;
  onDone: () => void;
}) {
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
          ✓ Invite sent to {req.email}
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
            <p className="text-sm font-semibold text-navy">{req.name} <span className="font-normal text-muted">at</span> {req.firm}</p>
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
            {(Object.entries(PLAN_LABELS) as [FirmPlan, string][]).map(([val, label]) => (
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
            style={{
              background:    '#0B1F3B',
              color:         '#C6A75E',
              letterSpacing: '0.12em',
            }}
          >
            {loading ? 'Sending…' : 'Approve + Send Invite'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Domain row ───────────────────────────────────────────────────────────────

function DomainRow({ info, onUpdated }: { info: DomainInfo; onUpdated: () => void }) {
  const [editing, setEditing]   = useState(false);
  const [plan,    setPlan]      = useState<FirmPlan>(info.plan);
  const [loading, setLoading]   = useState(false);

  const seatDisplay = info.seatLimit === null
    ? `${info.seatUsed} / ∞`
    : `${info.seatUsed} / ${info.seatLimit}`;

  async function savePlan() {
    setLoading(true);
    try {
      await fetch('/api/admin/domains', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: info.domain, plan }),
      });
      setEditing(false);
      onUpdated();
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${info.domain} from approved domains?`)) return;
    setLoading(true);
    try {
      await fetch('/api/admin/domains', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: info.domain }),
      });
      onUpdated();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3 border border-frame bg-cream">
      <p className="text-xs text-navy font-medium flex-1">{info.domain}</p>

      {editing ? (
        <select
          value={plan}
          onChange={e => setPlan(e.target.value as FirmPlan)}
          className="text-xs border border-frame bg-white px-2 py-1 focus:outline-none focus:border-navy"
        >
          {(Object.entries(PLAN_LABELS) as [FirmPlan, string][]).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      ) : (
        <span className="text-[11px] text-muted capitalize">{info.plan} plan</span>
      )}

      <span className="text-[11px] text-muted">{seatDisplay} seats</span>

      <div className="flex items-center gap-2">
        {editing ? (
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
              onClick={() => { setEditing(false); setPlan(info.plan); }}
              className="text-[10px] text-muted hover:text-navy transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors"
              style={{ letterSpacing: '0.1em' }}
            >
              Change Plan
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
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminRequestsPage() {
  const [requests,  setRequests]  = useState<AccessRequest[]>([]);
  const [domains,   setDomains]   = useState<DomainInfo[]>([]);
  const [reqLoad,   setReqLoad]   = useState(true);
  const [domLoad,   setDomLoad]   = useState(true);
  const [newDomain, setNewDomain] = useState('');
  const [addPlan,   setAddPlan]   = useState<FirmPlan>('starter');
  const [adding,    setAdding]    = useState(false);

  function loadRequests() {
    setReqLoad(true);
    fetch('/api/admin/requests')
      .then(r => r.json())
      .then(d => setRequests(d.requests ?? []))
      .catch(() => {})
      .finally(() => setReqLoad(false));
  }

  function loadDomains() {
    setDomLoad(true);
    fetch('/api/admin/domains')
      .then(r => r.json())
      .then(d => setDomains(d.domains ?? []))
      .catch(() => {})
      .finally(() => setDomLoad(false));
  }

  useEffect(() => { loadRequests(); loadDomains(); }, []);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!newDomain.trim() || adding) return;
    setAdding(true);
    try {
      await fetch('/api/admin/domains', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: newDomain.trim(), plan: addPlan }),
      });
      setNewDomain('');
      loadDomains();
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

        {/* ── Pending Requests ── */}
        <section>
          <div className="flex items-center gap-4 mb-5">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0" style={{ letterSpacing: '0.2em' }}>
              Pending Requests
            </p>
            <div className="flex-1 h-px bg-frame" />
          </div>

          {reqLoad ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="border border-frame bg-white px-5 py-4 space-y-2">
                  <div className="skeleton h-4 w-1/3 rounded" />
                  <div className="skeleton h-3 w-2/3 rounded" />
                </div>
              ))}
            </div>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted py-6">No pending access requests.</p>
          ) : (
            <div className="space-y-3">
              {requests.map(req => (
                <RequestCard
                  key={req.email}
                  req={req}
                  onDone={loadRequests}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Approved Domains ── */}
        <section>
          <div className="flex items-center gap-4 mb-5">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0" style={{ letterSpacing: '0.2em' }}>
              Approved Domains
            </p>
            <div className="flex-1 h-px bg-frame" />
          </div>

          {domLoad ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="border border-frame bg-cream px-4 py-3">
                  <div className="skeleton h-3.5 w-1/2 rounded" />
                </div>
              ))}
            </div>
          ) : domains.length === 0 ? (
            <p className="text-sm text-muted mb-4">No approved domains yet.</p>
          ) : (
            <div className="space-y-2 mb-6">
              {domains.map(d => (
                <DomainRow key={d.domain} info={d} onUpdated={loadDomains} />
              ))}
            </div>
          )}

          {/* Add domain form */}
          <form onSubmit={addDomain} className="flex items-end gap-3 mt-4">
            <div className="flex-1">
              <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                Add Domain
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
                {(Object.entries(PLAN_LABELS) as [FirmPlan, string][]).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={!newDomain.trim() || adding}
              className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background:    '#0B1F3B',
                color:         '#C6A75E',
                letterSpacing: '0.14em',
              }}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </form>
        </section>

      </main>
    </div>
  );
}
