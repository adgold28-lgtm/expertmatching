#!/usr/bin/env bash
# scripts/test-offline.sh — every offline test suite, the way CI runs them.
#
#   npm run test:offline        (or: bash scripts/test-offline.sh)
#
# There is no test runner in this repository (scripts/testHarness.ts says why):
# each suite is a plain program, `npx tsx scripts/<name>.ts`, that exits
# non-zero when any of its assertions fails. This script runs every
# scripts/test-*.ts plus the two check-*.ts invariants, skips the four that need
# a running app or live Redis (NEEDS_SERVER below; run those by hand against
# `next dev -p 3100`), prints one line per suite and exits 1 if any failed.
#
# No network, no database, no secrets: every suite here stubs what it needs.
# tsx itself is fetched by npx on first use and pinned so a laptop and CI run
# the same build; it is deliberately not a dependency of the app.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TSX="tsx@4.23.15"
SUITE_TIMEOUT_SECONDS=600

# These need `next dev -p 3100` (the three HTTP suites) or live Upstash
# credentials (test-upstash). They are listed, not forgotten.
NEEDS_SERVER="test-auth-flows test-auth-request-cache test-route-authz test-upstash"

passed=0
failed=0
skipped=0
failed_names=""

for file in scripts/test-*.ts scripts/check-redaction.ts scripts/check-env-drift.ts; do
  name=$(basename "$file" .ts)
  if printf '%s\n' $NEEDS_SERVER | grep -qx "$name"; then
    echo "SKIP  $name (needs a running app or live Redis)"
    skipped=$((skipped+1))
    continue
  fi
  if output=$(timeout "$SUITE_TIMEOUT_SECONDS" npx --yes "$TSX" "$file" 2>&1); then
    summary=$(printf '%s\n' "$output" | grep -E '^(PASS|FAIL)' | tail -1)
    echo "PASS  $name${summary:+ :: $summary}"
    passed=$((passed+1))
  else
    echo "FAIL  $name"
    printf '%s\n' "$output" | tail -40 | sed 's/^/      /'
    failed=$((failed+1))
    failed_names="$failed_names $name"
  fi
done

echo
echo "offline suites: $passed passed, $failed failed, $skipped skipped (need a server)"
if [ -n "$failed_names" ]; then
  echo "failed:$failed_names"
  exit 1
fi
exit 0
