'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// ─── Types ─────────────────────────────────────────────────────────────────────

type UserRole   = 'admin' | 'user';
type UserStatus = 'active' | 'pending' | 'disabled';

interface UserInfo {
  email:               string;
  role:                UserRole;
  firmName:            string;
  firmDomain:          string;
  status:              UserStatus;
  createdAt:           number;
  onboardingComplete?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
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
      const res  = await fetch('/api/admin/users', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: user.email }),
      });
      const data = await res.json() as Record<string, string>;
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Failed to delete user');
      onDeleted();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Something went wrong');
      setDeleting(false);
    }
  }

  const firmLabel = user.firmName
    ? user.firmDomain
      ? `${user.firmName} · ${user.firmDomain}`
      : user.firmName
    : user.firmDomain || (user.role === 'admin' ? 'ExpertMatch' : '—');

  return (
    <div className="flex items-center gap-4 px-4 py-3 border border-frame bg-cream">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-navy font-medium truncate">{user.email}</p>
        <p className="text-[10px] text-muted truncate">
          {firmLabel} · {formatDate(user.createdAt)}
        </p>
      </div>

      {/* Role badge */}
      <span
        className={`text-[10px] px-2 py-0.5 uppercase tracking-widest font-medium shrink-0 ${
          user.role === 'admin'
            ? 'bg-navy text-cream'
            : 'border border-frame text-muted'
        }`}
        style={{ letterSpacing: '0.1em' }}
      >
        {user.role}
      </span>

      {/* Status */}
      <span
        className={`text-[10px] uppercase tracking-widest font-medium shrink-0 ${statusColor}`}
        style={{ letterSpacing: '0.1em' }}
      >
        {user.status}
      </span>

      {errMsg && (
        <span className="text-[10px] text-red-600 shrink-0 max-w-[160px] truncate">
          {errMsg}
        </span>
      )}

      <button
        onClick={handleDelete}
        disabled={deleting}
        className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
        style={{ letterSpacing: '0.1em' }}
      >
        {deleting ? '…' : 'Delete'}
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  // User list
  const [users,   setUsers]   = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  // Add-user form
  const [email,      setEmail]      = useState('');
  const [password,   setPassword]   = useState('');
  const [confirm,    setConfirm]    = useState('');
  const [role,       setRole]       = useState<UserRole>('user');
  const [firmName,   setFirmName]   = useState('');
  const [firmDomain, setFirmDomain] = useState('');
  const [adding,     setAdding]     = useState(false);
  const [addErr,     setAddErr]     = useState('');
  const [addOk,      setAddOk]      = useState(false);

  const loadUsers = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    fetch('/api/admin/users?all=true')
      .then(r => r.json())
      .then((d: { users?: UserInfo[]; error?: string }) => {
        if (d.error) throw new Error(d.error);
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

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAddErr('');
    setAddOk(false);

    if (password !== confirm) {
      setAddErr('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setAddErr('Password must be at least 8 characters.');
      return;
    }

    setAdding(true);
    try {
      const res  = await fetch('/api/admin/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password, role, firmName, firmDomain }),
      });
      const data = await res.json() as Record<string, string>;
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Failed to create user');

      setAddOk(true);
      setEmail('');
      setPassword('');
      setConfirm('');
      setRole('user');
      setFirmName('');
      setFirmDomain('');
      loadUsers();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setAdding(false);
    }
  }

  const userCount = users.length;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* Header */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link
            href="/app"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/admin/requests"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Firms
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
          <SectionHeader
            title={`All Users${userCount > 0 ? ` (${userCount})` : ''}`}
          />

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
            <p className="text-sm text-muted py-2">No users yet. Create one below.</p>
          ) : (
            <div className="space-y-2">
              {users.map(u => (
                <UserRow key={u.email} user={u} onDeleted={loadUsers} />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 2: Add User ── */}
        <section>
          <SectionHeader title="Add User" />

          <form onSubmit={handleAddUser} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              {/* Email */}
              <div>
                <label
                  htmlFor="new-email"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-email"
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setAddOk(false); setAddErr(''); }}
                  placeholder="user@firm.com"
                  required
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>

              {/* Role */}
              <div>
                <label
                  htmlFor="new-role"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Role
                </label>
                <select
                  id="new-role"
                  value={role}
                  onChange={e => setRole(e.target.value as UserRole)}
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy"
                  disabled={adding}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {/* Firm Name */}
              <div>
                <label
                  htmlFor="new-firmname"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Firm Name
                </label>
                <input
                  id="new-firmname"
                  type="text"
                  value={firmName}
                  onChange={e => setFirmName(e.target.value)}
                  placeholder="Blackstone"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>

              {/* Firm Domain */}
              <div>
                <label
                  htmlFor="new-firmdomain"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Firm Domain
                </label>
                <input
                  id="new-firmdomain"
                  type="text"
                  value={firmDomain}
                  onChange={e => setFirmDomain(e.target.value)}
                  placeholder="blackstone.com"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="new-password"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Password <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setAddErr(''); }}
                  placeholder="Min. 8 characters"
                  required
                  autoComplete="new-password"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>

              {/* Confirm Password */}
              <div>
                <label
                  htmlFor="new-confirm"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Confirm Password <span className="text-red-500">*</span>
                </label>
                <input
                  id="new-confirm"
                  type="password"
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setAddErr(''); }}
                  placeholder="Re-enter password"
                  required
                  autoComplete="new-password"
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
                  disabled={adding}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="submit"
                disabled={!email.trim() || !password || !confirm || adding}
                className="text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
              >
                {adding ? 'Creating…' : 'Create User'}
              </button>
              {addErr && <p className="text-[11px] text-red-600">{addErr}</p>}
              {addOk  && <p className="text-[11px] text-green-700">User created successfully.</p>}
            </div>
          </form>
        </section>

      </main>
    </div>
  );
}
