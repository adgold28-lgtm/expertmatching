// Secure error helpers for API routes.
// Always log details server-side; never expose raw error messages or
// internal implementation details to clients.

const MAX_LOG_LENGTH = 120;

function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, MAX_LOG_LENGTH);
  return String(err).slice(0, MAX_LOG_LENGTH);
}

// Log an unhandled error server-side and return an opaque error response.
// Use this instead of sending err.message directly to the client.
export function serverError(context: string, err: unknown, code = 'internal_error'): Response {
  console.error(`[${context}]`, safeMessage(err));
  return Response.json({ error: code }, { status: 500 });
}

// Log a missing configuration problem server-side and return a safe 500 response.
// Never include env var names or config keys in the client-facing error.
export function configError(context: string, detail: string): Response {
  console.error(`[${context}] configuration error:`, detail);
  return Response.json({ error: 'configuration_error' }, { status: 500 });
}
