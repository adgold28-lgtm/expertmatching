// Next.js instrumentation hook — runs once at server startup.
// Only runs in the Node.js runtime (not Edge); safe to import Node-only modules here.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./lib/validateEnv');
    validateEnv();
  }
}
