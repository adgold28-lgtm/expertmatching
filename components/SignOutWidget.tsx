'use client';

export default function SignOutWidget() {
  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 100 }}>
      <button
        onClick={handleSignOut}
        className="text-[10px] uppercase font-medium px-3 py-2 transition-colors"
        style={{
          background: '#0B1F3B',
          color: 'rgba(198,167,94,0.7)',
          letterSpacing: '0.14em',
          border: '1px solid rgba(198,167,94,0.25)',
        }}
      >
        Sign Out
      </button>
    </div>
  );
}
