// scripts/testHarness.ts — the assertion counter every script under scripts/
// shares (audit L-42).
//
// There is no test runner in this repository: each script is a plain program run
// with `npx tsx scripts/<name>.ts` that counts its own assertions and exits
// non-zero if any failed. That counter used to be hand-copied into eighteen
// files, with drift already visible between the copies. This is the one copy.
//
// Exit-code contract, unchanged from the hand-rolled versions:
//   summary() exits 0 when nothing failed and 1 when anything did.
// A script that needs to exit for its own reasons (an async main that threw, a
// missing environment variable) still calls process.exit itself.
//
// Usage:
//   import { check, eq, summary } from './testHarness';
//   check('name', someBoolean, 'optional detail shown only on failure');
//   eq('name', actual, expected);
//   summary();                      // prints the PASS/FAIL line and exits
//
// Scripts that want a line per passing assertion (check-redaction.ts does) call
// setVerbose(true) once at the top.

let failures = 0;
let checks   = 0;
let verbose  = false;

/** Print an `ok` line for every passing assertion, not only failures. */
export function setVerbose(on: boolean): void {
  verbose = on;
}

/** Record one assertion. `detail` is printed only when it fails. */
export function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    if (verbose) console.log(`  ok    ${name}`);
    return;
  }
  failures++;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Record one equality assertion. Object.is, so NaN equals NaN. */
export function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Live counts, for a script that wants to branch on them before summarising. */
export function counts(): { checks: number; failures: number } {
  return { checks, failures };
}

/**
 * Print the final line and exit: 0 if every assertion passed, 1 otherwise.
 * `label` is appended to the PASS/FAIL word for scripts that name themselves.
 */
export function summary(label = ''): never {
  const passed = checks - failures;
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}${label ? ` ${label}` : ''} — ${passed}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}
