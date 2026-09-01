'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ─────────────────────────────────────────────────────────────────────

type UserRole   = 'admin' | 'user';
type UserStatus = 'active' | 'pending' | 'disabled';
type OrgRole    = 'org_admin' | 'org_member';

interface UserInfo {
  email:               string;
  role:                UserRole;
  firstName?:          string;
  lastName?:           string;
  firmName:            string;
  firmDomain:          string;
  orgRole?:            OrgRole;
  status:              UserStatus;
  createdAt:           number;
  onboardingComplete?: boolean;
}

interface FirmInfo {
  domain:    string;
  name:      string;
  seatUsed?: number;
}

const NEW_ORG = '__new__';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fullName(user: UserInfo): string {
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || user.email;
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

// ─── User row ─────────────────────────────────────────────────────────────────

function UserRow({
  user,
  onDeleted,
}: {
  user:      UserInfo;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [errMsg,   setErrMsg]   = useState('');

  const statusColor =
    user.status === 'active'  ? 'text-green-700' :
    user.status === 'pending' ? 'text-amber-600' :
    'text-red-600';

  async function handleDelete() {
    if (!confirm(`Permanently delete ${user.email}? This cannot be undone.`)) return;
    setDeleting(true);
    setErrMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: user.email }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onDeleted();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
      setDeleting(false);
    }
  }

  const orgLabel = user.firmName
    ? user.firmDomain
      ? `${user.firmName} · ${user.firmDomain}`
      : user.firmName
    : user.firmDomain || (user.role === 'admin' ? 'ExpertMatch' : '—');

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 border border-frame bg-cream">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-navy font-medium truncate">{fullName(user)}</p>
        <p className="text-[10px] text-muted truncate">
          {user.email} · {orgLabel} · {formatDate(user.createdAt)}
        </p>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {/* Role badge */}
        <span
          className={`text-[10px] px-2 py-0.5 uppercase tracking-widest font-medium ${
            user.role === 'admin'
              ? 'bg-navy text-cream'
              : user.orgRole === 'org_admin'
                ? 'border border-navy text-navy'
                : 'border border-frame text-muted'
          }`}
          style={{ letterSpacing: '0.1em' }}
        >
          {user.role === 'admin' ? 'Platform admin' : user.orgRole === 'org_admin' ? 'Org admin' : 'User'}
        </span>

        <span
          className={`text-[10px] uppercase tracking-widest font-medium ${statusColor}`}
          style={{ letterSpacing: '0.1em' }}
        >
          {user.status}
        </span>

        {errMsg && (
          <span className="text-[10px] text-red-600 max-w-[160px] truncate">{errMsg}</span>
        )}

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40"
          style={{ letterSpacing: '0.1em' }}
        >
          {deleting ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  // User list
  const [users,   setUsers]   = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  // Organizations (for the picker)
  const [firms,     setFirms]     = useState<FirmInfo[]>([]);
  const [firmsErr,  setFirmsErr]  = useState('');

  // Create-account form
  const [firstName,  setFirstName]  = useState('');
  const [lastName,   setLastName]   = useState('');
  const [email,      setEmail]      = useState('');
  const [orgChoice,  setOrgChoice]  = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgDom,  setNewOrgDom]  = useState('');
  const [role,       setRole]       = useState<UserRole>('user');
  const [adding,     setAdding]     = useState(false);
  const [addErr,     setAddErr]     = useState('');
  const [addOk,      setAddOk]      = useState('');

  const loadUsers = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    fetch('/api/admin/users?all=true')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ users?: UserInfo[] }>;
      })
      .then((d) => {
        // Admins first, then alphabetical by email.
        const sorted = (d.users ?? []).sort((a, b) => {
          if (a.role === 'admin' && b.role !== 'admin') return -1;
          if (a.role !== 'admin' && b.role === 'admin') return  1;
          return a.email.localeCompare(b.email);
        });
        setUsers(sorted);
      })
      .catch((e: unknown) =>
        setLoadErr(e instanceof Error ? e.message : 'Failed to load users'),
      )
      .finally(() => setLoading(false));
  }, []);

  const loadFirms = useCallback(() => {
    setFirmsErr('');
    fetch('/api/admin/firms')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ firms?: FirmInfo[] }>;
      })
      .then(d => setFirms((d.firms ?? []).sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e: unknown) =>
        setFirmsErr(e instanceof Error ? e.message : 'Failed to load organizations'),
      );
  }, []);

  useEffect(() => { loadUsers(); loadFirms(); }, [loadUsers, loadFirms]);

  const creatingNewOrg = orgChoice === NEW_ORG;

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAddErr('');
    setAddOk('');

    if (!orgChoice) {
      setAddErr('Choose an organization for this account.');
      return;
    }

    const organization = creatingNewOrg
      ? { domain: newOrgDom.trim().toLowerCase(), name: newOrgName.trim() }
      : { domain: orgChoice };

    if (creatingNewOrg && (!organization.domain || !organization.name)) {
      setAddErr('New organizations need both a name and a domain.');
      return;
    }

    setAdding(true);
    try {
      const res = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName: firstName.trim(),
          lastName:  lastName.trim(),
          email:     email.trim(),
          organization,
          role,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json() as { emailSent?: boolean };

      setAddOk(
        data.emailSent === false
          ? `Account created for ${email.trim()}, but the invite email could not be delivered.`
          : `Invite sent to ${email.trim()}.`,
      );
      setFirstName('');
      setLastName('');
      setEmail('');
      setNewOrgName('');
      setNewOrgDom('');
      setRole('user');
      loadUsers();
      loadFirms();
    } catch (err) {
      setAddErr(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setAdding(false);
    }
  }

  const userCount  = users.length;
  const inputClass =
    'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50';
  const labelClass = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* Header */}
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
            <Link
              href="/admin/requests"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Organizations
            </Link>
            <span
              className="text-[10px] uppercase tracking-widest text-gold/80"
              style={{ letterSpacing: '0.18em' }}
            >
              Users
            </span>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-14">

        {/* ── Section 1: All Users ── */}
        <section>
          <SectionHeader title={`All Users${userCount > 0 ? ` (${userCount})` : ''}`} />

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="border border-frame bg-cream px-4 py-3">
                  <div className="h-3 w-1/2 bg-frame rounded animate-pulse mb-1.5" />
                  <div className="h-2.5 w-1/3 bg-frame rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : loadErr ? (
            <div className="border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-xs text-red-600">{loadErr}</p>
              <button
                onClick={loadUsers}
                className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                Retry
              </button>
            </div>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted py-2">No users yet. Create the first account below.</p>
          ) : (
            <div className="space-y-2">
              {users.map(u => (
                <UserRow key={u.email} user={u} onDeleted={loadUsers} />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 2: Create Account ── */}
        <section>
          <SectionHeader title="Create Account" />

          <p className="text-[11px] text-muted mb-5 leading-relaxed" style={{ fontWeight: 300 }}>
            Every account starts as an invite — the person sets their own password from the emailed
            link. Name, email and organization are required.
          </p>

          <form onSubmit={handleCreateAccount} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              {/* First name */}
              <div>
                <label htmlFor="new-first" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                  First name <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-first"
                  type="text"
                  value={firstName}
                  onChange={e => { setFirstName(e.target.value); setAddErr(''); setAddOk(''); }}
                  placeholder="Jane"
                  maxLength={100}
                  required
                  disabled={adding}
                  className={inputClass}
                />
              </div>

              {/* Last name */}
              <div>
                <label htmlFor="new-last" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                  Last name <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-last"
                  type="text"
                  value={lastName}
                  onChange={e => { setLastName(e.target.value); setAddErr(''); setAddOk(''); }}
                  placeholder="Okafor"
                  maxLength={100}
                  required
                  disabled={adding}
                  className={inputClass}
                />
              </div>

              {/* Email */}
              <div>
                <label htmlFor="new-email" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-email"
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setAddErr(''); setAddOk(''); }}
                  placeholder="jane@firm.com"
                  required
                  disabled={adding}
                  className={inputClass}
                />
              </div>

              {/* Role */}
              <div>
                <label htmlFor="new-role" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                  Role
                </label>
                <select
                  id="new-role"
                  value={role}
                  onChange={e => setRole(e.target.value as UserRole)}
                  disabled={adding}
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy"
                >
                  <option value="user">User</option>
                  <option value="admin">Platform admin</option>
                </select>
              </div>

              {/* Organization */}
              <div className="sm:col-span-2">
                <label htmlFor="new-org" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                  Organization <span className="text-red-500">*</span>
                </label>
                <select
                  id="new-org"
                  value={orgChoice}
                  onChange={e => { setOrgChoice(e.target.value); setAddErr(''); setAddOk(''); }}
                  disabled={adding}
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy"
                >
                  <option value="">Select an organization…</option>
                  {firms.map(f => (
                    <option key={f.domain} value={f.domain}>
                      {f.name} — {f.domain}
                    </option>
                  ))}
                  <option value={NEW_ORG}>New organization…</option>
                </select>
                {firmsErr && <p className="text-[10px] text-red-600 mt-1.5">{firmsErr}</p>}
              </div>

              {creatingNewOrg && (
                <>
                  <div>
                    <label htmlFor="new-org-name" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                      Organization name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="new-org-name"
                      type="text"
                      value={newOrgName}
                      onChange={e => { setNewOrgName(e.target.value); setAddErr(''); }}
                      placeholder="Blackstone"
                      maxLength={100}
                      disabled={adding}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="new-org-domain" className={labelClass} style={{ letterSpacing: '0.14em' }}>
                      Organization domain <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="new-org-domain"
                      type="text"
                      value={newOrgDom}
                      onChange={e => { setNewOrgDom(e.target.value); setAddErr(''); }}
                      placeholder="blackstone.com"
                      disabled={adding}
                      className={inputClass}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="submit"
                disabled={adding || !firstName.trim() || !lastName.trim() || !email.trim() || !orgChoice}
                className="text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
              >
                {adding ? 'Sending invite…' : 'Create Account'}
              </button>
              {addErr && <p className="text-[11px] text-red-600">{addErr}</p>}
              {addOk  && <p className="text-[11px] text-green-700">{addOk}</p>}
            </div>
          </form>
        </section>

      </main>
    </div>
  );
}
