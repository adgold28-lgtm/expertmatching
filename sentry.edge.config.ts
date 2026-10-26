// Sentry for the Edge runtime, where middleware.ts runs. Loaded once at boot by
// instrumentation.ts register(). Everything is in lib/sentry.ts.
import { initSentry } from './lib/sentry';

initSentry('edge');
