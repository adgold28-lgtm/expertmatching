// Sentry for the browser. On Next 14 the @sentry/nextjs build plugin adds this
// file to the client entry; from Next 15.3 Next loads it itself under this
// same name, so the upgrade needs no rename. Everything is in lib/sentry.ts.
import { initSentry } from './lib/sentry';

initSentry('client');
