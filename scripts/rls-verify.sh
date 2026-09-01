#!/usr/bin/env bash
#
# scripts/rls-verify.sh — prove ExpertMatch's cross-account isolation.
#
# Default (local): builds a throwaway PostgreSQL database, applies the Supabase
# shim and every migration in supabase/migrations/ in filename order, runs
# scripts/rls/verify.sql, prints the summary, and drops the database again
# (including on failure).
#
#   scripts/rls-verify.sh
#
# Against a real database (staging or production): set DATABASE_URL. The shim
# and migrations are skipped — only verify.sql runs, and it runs inside a single
# transaction that ends in ROLLBACK, so it writes nothing that survives.
#
#   DATABASE_URL='postgres://postgres:...@db.<ref>.supabase.co:5432/postgres' scripts/rls-verify.sh
#
# Exit code is the verification result: 0 = every assertion passed.
#
# Optional environment:
#   PSQL   override the psql invocation (default: auto-detected superuser psql)
#   KEEP_DB=1  keep the throwaway database for inspection (local mode only)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM="$ROOT/scripts/rls/supabase-shim.sql"
VERIFY="$ROOT/scripts/rls/verify.sql"

for f in "$SHIM" "$VERIFY"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }
done

# ── Remote mode: verify against DATABASE_URL, transactional and read-only ────
if [ -n "${DATABASE_URL:-}" ]; then
  echo "RLS verify: running against DATABASE_URL (single transaction, rolled back)"
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$VERIFY"
  exit $?
fi

# ── Local mode: pick a psql that can create databases ────────────────────────
if [ -z "${PSQL:-}" ]; then
  if psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    PSQL="psql -U postgres"
  elif command -v sudo >/dev/null 2>&1 && sudo -n -u postgres psql -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    PSQL="sudo -u postgres psql"
  elif psql -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    PSQL="psql"
  else
    cat >&2 <<'EOF'
Could not reach a local PostgreSQL superuser.

Start PostgreSQL, then either make `psql -U postgres` work, or set PSQL, e.g.
  PSQL="sudo -u postgres psql" scripts/rls-verify.sh
Or verify a remote database instead:
  DATABASE_URL='postgres://...' scripts/rls-verify.sh
EOF
    exit 2
  fi
fi

DB="expertmatch_rls_$$"
CREATED=0

cleanup() {
  local status=$?
  if [ "$CREATED" = "1" ]; then
    if [ "${KEEP_DB:-0}" = "1" ]; then
      echo "RLS verify: keeping database $DB (KEEP_DB=1)"
    else
      $PSQL -d postgres -q -c "drop database if exists \"$DB\" with (force)" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

echo "RLS verify: creating throwaway database $DB"
$PSQL -d postgres -q -c "create database \"$DB\""
CREATED=1

# The leading -c raises the message threshold for the session, hiding the
# "policy ... does not exist, skipping" notices that the idempotent
# `drop policy if exists` statements emit on a fresh database. (It cannot go in
# PGOPTIONS: $PSQL may be a sudo invocation, which strips the environment.)
run() {
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q \
    -c 'set client_min_messages = warning' -f "$1"
}

echo "RLS verify: applying Supabase shim"
run "$SHIM"

# Filename order is migration order (timestamp-prefixed), which is the same
# order Supabase applies them in.
for m in "$ROOT"/supabase/migrations/*.sql; do
  echo "RLS verify: applying $(basename "$m")"
  run "$m"
done

# Every migration claims to be idempotent, and they are applied by hand in the
# Supabase SQL editor — so re-running them is a real scenario. Prove it.
echo "RLS verify: re-applying all migrations (idempotency check)"
for m in "$ROOT"/supabase/migrations/*.sql; do
  run "$m"
done

echo "RLS verify: running assertions"
$PSQL -d "$DB" -q -v ON_ERROR_STOP=1 -f "$VERIFY"
