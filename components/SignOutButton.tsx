'use client';

const GOLD = '#C6A75E';

export default function SignOutButton() {
  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <button
      onClick={handleSignOut}
      className="text-[11px] uppercase border px-4 py-2 transition-colors"
      style={{ letterSpacing: '0.14em', color: GOLD, borderColor: `${GOLD}40` }}
    >
      Sign Out
    </button>
  );
}
