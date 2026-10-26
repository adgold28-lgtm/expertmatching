// Sentry for the Node runtime. Loaded once at boot by instrumentation.ts
// register(). Everything is in lib/sentry.ts.
import { initSentry } from './lib/sentry';

initSentry('server');
