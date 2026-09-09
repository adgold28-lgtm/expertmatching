'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatUsdFromCents } from '../../../lib/pricing';

// -----------------------------------------------------------------------------
// /settings/team — org-admin ("champion") seat management: invite, disable/
// enable, promote/demote, and remove teammates, plus the seat-tier billing
// summary (lib/pricing.ts SEAT_TIERS). Every mutation goes through
// /api/org/members (POST invite, PATCH status/role, DELETE); this page adds
// no authorization of its own — a 401/403 from that route flips `denied` and
// swaps in the "ask your champion" panel, so the real gate lives server-side
// and this is purely the UI reaction to it. Never renders another org's data:
// GET /api/org/members scopes to the caller's own organization.
// -----------------------------------------------------------------------------

// ─── Types (mirror /api/org/members) ──────────────────────────────────────────

type OrgRole    = 'org_admin' | 'org_member';
type UserStatus = 'active' | 'pending' | 'disabled';

interface Member {
  email:              string;
  firstName:          string;
  lastName:           string;
  role:               'admin' | 'user';
  orgRole:            OrgRole;
  status:             UserStatus;
  createdAt:          number;
  onboardingComplete: boolean;
}

interface Seats {
  active:            number;
  pending:           number;
  unitPriceCents:    number;
  monthlyTotalCents: number;
  nextTier: {
    seatsUntil:     number;
    atSeatCount:    number;
    unitPriceCents: number;
  } | null;
}

interface TeamResponse {
  organization: { id: string; name: string; domain: string; status: string; seatLimit: number | null };
  viewer:       { email: string; role: 'admin' | 'user'; orgRole: OrgRole };
  members:      Member[];
  seats:        Seats;
  error?:       string;
  message?:     string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function displayName(m: Member): string {
  const full = `${m.firstName} ${m.lastName}`.trim();
  return full || m.email;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

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

function StatusBadge({ status }: { status: UserStatus }) {
  const color =
    status === 'active'  ? 'text-green-700' :
    status === 'pending' ? 'text-amber-600' :
    'text-red-600';
  return (
    <span
      className={`text-[10px] uppercase tracking-widest font-medium ${color}`}
      style={{ letterSpacing: '0.1em' }}
    >
      {status}
    </span>
  );
}

function RoleBadge({ member }: { member: Member }) {
  const isAdmin = member.orgRole === 'org_admin' || member.role === 'admin';
  return (
    <span
      className={`text-[10px] px-2 py-0.5 uppercase tracking-widest font-medium ${
        isAdmin ? 'bg-navy text-cream' : 'border border-frame text-muted'
      }`}
      style={{ letterSpacing: '0.1em' }}
    >
      {member.role === 'admin' ? 'Platform admin' : isAdmin ? 'Champion' : 'Member'}
    </span>
  );
}

// ─── Seat summary ─────────────────────────────────────────────────────────────

function SeatSummary({ seats, seatLimit }: { seats: Seats; seatLimit: number | null }) {
  const tiles = [
    { label: 'Active seats',  value: String(seats.active) },
    { label: 'Per seat / mo', value: formatUsdFromCents(seats.unitPriceCents) },
    { label: 'Monthly total', value: formatUsdFromCents(seats.monthlyTotalCents) },
    { label: 'Pending invites', value: String(seats.pending) },
  ];

  return (
    <div className="border border-frame bg-white">
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-frame">
        {tiles.map((tile, i) => (
          <div
            key={tile.label}
            className={`px-5 py-4 ${i < 2 ? 'border-b sm:border-b-0 border-frame' : ''}`}
          >
            <p
              className="text-[20px] font-semibold leading-none"
              style={{ color: '#0B1F3B', fontFamily: 'var(--font-display)' }}
            >
              {tile.value}
            </p>
            <p
              className="text-[10px] uppercase tracking-widest mt-1.5 text-muted"
              style={{ letterSpacing: '0.14em' }}
            >
              {tile.label}
            </p>
          </div>
        ))}
      </div>

      <div className="border-t border-frame px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
        <p className="text-[11px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
          Billed monthly per active seat, prorated when seats change.
        </p>
        {seats.nextTier && (
          <p className="text-[11px] sm:ml-auto" style={{ color: '#8B6914' }}>
            {seats.nextTier.seatsUntil} more seat{seats.nextTier.seatsUntil === 1 ? '' : 's'} until{' '}
            {formatUsdFromCents(seats.nextTier.unitPriceCents)}/seat
          </p>
        )}
        {seatLimit !== null && (
          <p className="text-[11px] text-muted sm:ml-auto">
            Seat cap: {seats.active} / {seatLimit}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Member row ───────────────────────────────────────────────────────────────

function MemberRow({
  member,
  viewerEmail,
  onChanged,
}: {
  member:      Member;
  viewerEmail: string;
  onChanged:   () => void;
}) {
  const [busy,   setBusy]   = useState<'' | 'status' | 'role' | 'remove'>('');
  const [errMsg, setErrMsg] = useState('');

  const isSelf     = member.email.toLowerCase() === viewerEmail.toLowerCase();
  const isOrgAdmin = member.orgRole === 'org_admin';

  async function patch(payload: Record<string, string>, kind: 'status' | 'role') {
    setBusy(kind);
    setErrMsg('');
    try {
      const res = await fetch('/api/org/members', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: member.email, ...payload }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChanged();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (!confirm(`Remove ${displayName(member)} from your team? This cannot be undone.`)) return;
    setBusy('remove');
    setErrMsg('');
    try {
      const res = await fetch('/api/org/members', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: member.email }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChanged();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy('');
    }
  }

  const actionClass =
    'text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0';

  return (
    <div className="border border-frame bg-cream px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-navy font-medium truncate">
            {displayName(member)}{isSelf && <span className="text-muted font-normal"> · you</span>}
          </p>
          <p className="text-[10px] text-muted truncate">
            {member.email} · joined {formatDate(member.createdAt)}
            {member.status === 'pending' ? ' · invite pending' : ''}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <RoleBadge member={member} />
          <StatusBadge status={member.status} />
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {member.status !== 'pending' && (
            <button
              onClick={() => patch({ status: member.status === 'active' ? 'disabled' : 'active' }, 'status')}
              disabled={busy !== '' || (isSelf && member.status === 'active')}
              className={actionClass}
              style={{ letterSpacing: '0.1em' }}
              title={isSelf && member.status === 'active' ? 'You cannot disable your own seat' : undefined}
            >
              {busy === 'status' ? '…' : member.status === 'active' ? 'Disable' : 'Enable'}
            </button>
          )}

          {member.role !== 'admin' && member.status === 'active' && (
            <button
              onClick={() => patch({ orgRole: isOrgAdmin ? 'org_member' : 'org_admin' }, 'role')}
              disabled={busy !== ''}
              className={actionClass}
              style={{ letterSpacing: '0.1em' }}
            >
              {busy === 'role' ? '…' : isOrgAdmin ? 'Make member' : 'Make champion'}
            </button>
          )}

          {member.status !== 'active' && !isSelf && (
            <button
              onClick={remove}
              disabled={busy !== ''}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
              style={{ letterSpacing: '0.1em' }}
            >
              {busy === 'remove' ? '…' : 'Remove'}
            </button>
          )}
        </div>
      </div>

      {errMsg && <p className="text-[10px] text-red-600 mt-2">{errMsg}</p>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const [data,    setData]    = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [denied,  setDenied]  = useState(false);

  // Invite form
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [inviting,  setInviting]  = useState(false);
  const [inviteErr, setInviteErr] = useState('');
  const [inviteOk,  setInviteOk]  = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    fetch('/api/org/members')
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setDenied(true);
          return null;
        }
        if (!res.ok) throw new Error(await readError(res));
        return res.json() as Promise<TeamResponse>;
      })
      .then((d) => { if (d) { setData(d); setDenied(false); } })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : 'Failed to load your team.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (inviting) return;
    setInviting(true);
    setInviteErr('');
    setInviteOk('');
    try {
      const res = await fetch('/api/org/members', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName: firstName.trim(),
          lastName:  lastName.trim(),
          email:     email.trim(),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json() as { emailSent?: boolean; warning?: string };
      setInviteOk(
        body.emailSent === false
          ? `Seat created for ${email.trim()}, but the invite email could not be delivered.`
          : `Invite sent to ${email.trim()}.`,
      );
      setFirstName('');
      setLastName('');
      setEmail('');
      load();
    } catch (err) {
      setInviteErr(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setInviting(false);
    }
  }

  const members    = data?.members ?? [];
  const orgName    = data?.organization.name || data?.organization.domain || 'Your organization';
  const inputClass =
    'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50';
  const labelClass = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-4 sm:gap-5 flex-wrap justify-end">
            <span
              className="text-[10px] uppercase tracking-widest text-gold/80"
              style={{ letterSpacing: '0.18em' }}
            >
              Team
            </span>
            <Link
              href="/settings"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              ← Settings
            </Link>
            <Link
              href="/app"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              ← Projects
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-12">

        {denied ? (
          <div className="border border-frame bg-white px-6 py-10 text-center">
            <p className="text-sm font-semibold text-navy mb-2">Team management is for your firm’s champion</p>
            <p className="text-xs text-muted leading-relaxed max-w-sm mx-auto" style={{ fontWeight: 300 }}>
              Ask your firm’s champion to add or remove seats.
            </p>
            <Link
              href="/app"
              className="inline-block mt-6 text-[10px] uppercase tracking-widest px-5 py-2.5"
              style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
            >
              Back to projects
            </Link>
          </div>
        ) : (
          <>
            {/* ── Seats ── */}
            <section>
              <SectionHeader title={loading ? 'Seats' : `Seats — ${orgName}`} />

              {loading ? (
                <div className="border border-frame bg-white">
                  <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-frame">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="px-5 py-4">
                        <div className="h-5 w-12 bg-frame rounded animate-pulse mb-2" />
                        <div className="h-2.5 w-20 bg-frame rounded animate-pulse" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : loadErr ? (
                <div className="border border-red-200 bg-red-50 px-4 py-3">
                  <p className="text-xs text-red-600">{loadErr}</p>
                  <button
                    onClick={load}
                    className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
                    style={{ letterSpacing: '0.12em' }}
                  >
                    Retry
                  </button>
                </div>
              ) : data ? (
                <SeatSummary seats={data.seats} seatLimit={data.organization.seatLimit} />
              ) : null}
            </section>

            {/* ── Members ── */}
            <section>
              <SectionHeader title={`Members${members.length ? ` (${members.length})` : ''}`} />

              {loading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="border border-frame bg-cream px-4 py-3">
                      <div className="h-3 w-1/3 bg-frame rounded animate-pulse mb-1.5" />
                      <div className="h-2.5 w-1/2 bg-frame rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : loadErr ? null : members.length === 0 ? (
                <p className="text-sm text-muted py-2">
                  No teammates yet. Invite your first colleague below.
                </p>
              ) : (
                <div className="space-y-2">
                  {members.map(m => (
                    <MemberRow
                      key={m.email}
                      member={m}
                      viewerEmail={data?.viewer.email ?? ''}
                      onChanged={load}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ── Invite ── */}
            <section>
              <SectionHeader title="Add a seat" />

              <form onSubmit={invite} className="space-y-4" noValidate>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="invite-first" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                      First name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="invite-first"
                      type="text"
                      value={firstName}
                      onChange={e => { setFirstName(e.target.value); setInviteErr(''); setInviteOk(''); }}
                      placeholder="Jane"
                      maxLength={100}
                      required
                      disabled={inviting}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="invite-last" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                      Last name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="invite-last"
                      type="text"
                      value={lastName}
                      onChange={e => { setLastName(e.target.value); setInviteErr(''); setInviteOk(''); }}
                      placeholder="Okafor"
                      maxLength={100}
                      required
                      disabled={inviting}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="invite-email" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                      Work email <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="invite-email"
                      type="email"
                      value={email}
                      onChange={e => { setEmail(e.target.value); setInviteErr(''); setInviteOk(''); }}
                      placeholder={data ? `jane@${data.organization.domain}` : 'jane@firm.com'}
                      required
                      disabled={inviting}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <button
                    type="submit"
                    disabled={inviting || !firstName.trim() || !lastName.trim() || !email.trim()}
                    className="text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
                  >
                    {inviting ? 'Sending…' : 'Send invite'}
                  </button>
                  <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
                    New seats are billed from the day the invite is accepted.
                  </p>
                </div>

                {inviteErr && <p className="text-[11px] text-red-600">{inviteErr}</p>}
                {inviteOk  && <p className="text-[11px] text-green-700">{inviteOk}</p>}
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
