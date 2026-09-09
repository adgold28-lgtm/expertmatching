'use client';

// Sign-out control for the marketing/app headers.
//
// POSTs to /api/auth/logout (which clears every sb-* cookie), then does a FULL
// page load to '/' rather than router.push: the cleared session lives in
// cookies, and only a real navigation re-runs middleware.ts so the user is not
// left looking at a cached authenticated shell. The response is deliberately
// not inspected — logout always answers ok, and a network failure should still
// take the user off the app.

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
