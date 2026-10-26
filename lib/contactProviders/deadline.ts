// lib/contactProviders/deadline.ts — the one timeout helper the email-finder
// providers share. It used to be copied into each provider file.
//
// Aborts on whichever comes first: the provider's own timeout or the caller's
// deadline (lib/contactDiscovery.ts passes one so a single provider can never
// eat the whole job's wall clock). Returns the controller plus a cleanup that
// releases the timer and the listener; call the cleanup in a `finally`.

export function boundedController(timeoutMs: number, external?: AbortSignal): {
  controller: AbortController;
  cleanup:    () => void;
} {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort    = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}
