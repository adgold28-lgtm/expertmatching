#!/usr/bin/env bash
# Automated security scan for ExpertMatch.
# Run: npm run security   (or: bash scripts/security-scan.sh)
#
# Checks:
#   1. npm audit — a HIGH/CRITICAL advisory that is not on the accepted list FAILS
#   2. TypeScript compilation — tsc --noEmit
#   3. Hardcoded secrets — grep patterns
#   4. Insecure env-var fallbacks — dev-insecure-fallback outside contactCache
#   5. XSS sinks — dangerouslySetInnerHTML / eval / innerHTML
#   6. console.log anywhere in app code — FAILS; lib/log.ts is the logger
#   7. TypeScript `any` usage — weakens type safety
#   8. Undocumented env vars — process.env references not in validateEnv
#
# Exit status 1 when any check FAILS; WARN items print but do not fail the run.
# Runs in CI (.github/workflows/ci.yml) on every pull request.
#
# Counters are bumped with `PASS=$((PASS+1))`, never `((PASS++))`: under
# `set -e` the latter returns exit status 1 when the counter is 0, which used to
# stop this script silently after its first PASS line.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
WARN=0

# ANSI colours (suppressed if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'; RESET='\033[0m'; BOLD='\033[1m'
else
  RED=''; YELLOW=''; GREEN=''; RESET=''; BOLD=''
fi

pass() { echo -e "${GREEN}  PASS${RESET}  $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}  FAIL${RESET}  $1"; FAIL=$((FAIL+1)); }
warn() { echo -e "${YELLOW}  WARN${RESET}  $1"; WARN=$((WARN+1)); }
header() { echo -e "\n${BOLD}=== $1 ===${RESET}"; }

cd "$ROOT"

# ─── 1. npm audit ─────────────────────────────────────────────────────────────
header "1. Dependency vulnerabilities (npm audit)"

# Advisories the founder accepted on 2026-10-18 (decision D6, recorded in
# TASK_QUEUE.md): every one of them clears only with a breaking major upgrade
# (Next 15.5 / Tailwind 4), scheduled this month as its own PR. A high or
# critical advisory that is NOT in this list fails the scan. When the upgrade
# lands and `npm audit` stops reporting an id, delete it here.
# Review by 2026-11-30: if any id is still listed then, the upgrade slipped.
ACCEPTED_ADVISORIES=(
  GHSA-vfj7-8cjw-p6xm   # braces (under tailwindcss 3): stack exhaustion on nested patterns
  GHSA-6g55-p6wh-862q   # postcss (under next): sourceMappingURL arbitrary file read
  GHSA-r28c-9q8g-f849   # postcss (under next): sourceMappingURL path traversal
  GHSA-h25m-26qc-wcjf   # next: RSC request deserialization DoS
  GHSA-q4gf-8mx6-v5v3   # next: Server Components DoS
  GHSA-8h8q-6873-q5fj   # next: Server Components DoS
  GHSA-c4j6-fc7j-m34r   # next: SSRF via WebSocket upgrades
  GHSA-36qx-fr4f-26g5   # next: middleware bypass in Pages Router i18n (not used here)
  GHSA-m99w-x7hq-7vfj   # next: Server Actions DoS
  GHSA-89xv-2m56-2m9x   # next: SSRF in Server Actions on custom servers (not used here)
  GHSA-p9j2-gv94-2wf4   # next: SSRF in rewrites (no rewrites configured)
  GHSA-p293-qw3h-jr36   # next: RCE on Windows-hosted servers (Vercel runs Linux)
  GHSA-2xp9-vwfh-vxw4   # next: RCE in the image optimizer (images.unoptimized is set)
)

AUDIT_JSON=$(npm audit --json 2>/dev/null || true)
# One line per distinct HIGH/CRITICAL advisory: id, severity, package, title
# (tab-separated). AUDIT_UNAVAILABLE when npm could not reach the registry.
AUDIT_ROWS=$(printf '%s' "$AUDIT_JSON" | node -e '
  let audit;
  try { audit = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { audit = null; }
  if (!audit || audit.error || !audit.vulnerabilities) { console.log("AUDIT_UNAVAILABLE"); process.exit(0); }
  const seen = new Set();
  for (const [pkg, entry] of Object.entries(audit.vulnerabilities)) {
    for (const via of entry.via) {
      if (typeof via !== "object" || !via.url) continue;
      if (via.severity !== "high" && via.severity !== "critical") continue;
      const id = via.url.split("/").pop();
      if (seen.has(id)) continue;
      seen.add(id);
      console.log([id, via.severity, pkg, via.title].join("\t"));
    }
  }
')

if [ "$AUDIT_ROWS" = "AUDIT_UNAVAILABLE" ]; then
  if [ -n "${CI:-}" ]; then
    # In CI a registry blip must not turn into a green badge with no dependency check.
    fail "npm audit did not run (no registry access?) — CI cannot vouch for dependencies"
  else
    warn "npm audit did not run (no registry access?) — rerun with network before merging"
  fi
else
  NEW_ADVISORIES=""
  ACCEPTED_SEEN=0
  while IFS=$'\t' read -r ADV_ID ADV_SEVERITY ADV_PKG ADV_TITLE; do
    [ -z "$ADV_ID" ] && continue
    if printf '%s\n' "${ACCEPTED_ADVISORIES[@]}" | grep -qx "$ADV_ID"; then
      ACCEPTED_SEEN=$((ACCEPTED_SEEN+1))
    else
      NEW_ADVISORIES="$NEW_ADVISORIES\n  $ADV_ID ($ADV_SEVERITY) $ADV_PKG: $ADV_TITLE"
    fi
  done <<< "$AUDIT_ROWS"

  if [ -n "$NEW_ADVISORIES" ]; then
    fail "npm audit reports HIGH/CRITICAL advisories that are not on the accepted list:"
    echo -e "$NEW_ADVISORIES"
  else
    TOTALS=$(printf '%s' "$AUDIT_JSON" | node -e '
      const m = JSON.parse(require("fs").readFileSync(0, "utf8")).metadata.vulnerabilities;
      console.log(`${m.total} finding(s): ${m.critical} critical, ${m.high} high, ${m.moderate} moderate, ${m.low} low`);
    ')
    pass "No new HIGH/CRITICAL advisories ($ACCEPTED_SEEN accepted pending the Next 15.5 / Tailwind 4 upgrade; $TOTALS)"
  fi
fi

# ─── 2. TypeScript compilation ────────────────────────────────────────────────
header "2. TypeScript type check (tsc --noEmit)"

TSC_OUTPUT=$(npx tsc --noEmit 2>&1 || true)
TSC_ERRORS=$(echo "$TSC_OUTPUT" | grep -c "error TS" || true)
if [ "$TSC_ERRORS" -gt 0 ]; then
  fail "$TSC_ERRORS TypeScript error(s) found"
  echo "$TSC_OUTPUT" | grep "error TS" | head -10
else
  pass "No TypeScript compilation errors"
fi

# ─── 3. Hardcoded secrets ─────────────────────────────────────────────────────
header "3. Hardcoded secrets"

SECRET_PATTERNS=(
  'sk_live_[a-zA-Z0-9]'
  'sk_test_[a-zA-Z0-9]'
  'whsec_[a-zA-Z0-9]'
  'rk_live_[a-zA-Z0-9]'
  'AKIA[0-9A-Z]{16}'
  'Bearer [a-zA-Z0-9_\-]{20}'
  'ghp_[a-zA-Z0-9]{36}'
)

FOUND_SECRETS=0
for PATTERN in "${SECRET_PATTERNS[@]}"; do
  MATCHES=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.js" \
    -E "$PATTERN" "$ROOT/app" "$ROOT/lib" "$ROOT/components" 2>/dev/null \
    | grep -v "\.env\.example\|\.env\.local" | grep -vE '^[^:]+:[0-9]+:\s*//' || true)
  if [ -n "$MATCHES" ]; then
    fail "Possible hardcoded secret matching pattern '$PATTERN':"
    echo "$MATCHES" | head -5
    FOUND_SECRETS=1
  fi
done

if [ "$FOUND_SECRETS" -eq 0 ]; then
  pass "No hardcoded API keys or tokens detected"
fi

# ─── 4. Insecure env-var fallbacks ────────────────────────────────────────────
header "4. Insecure fallback strings"

FALLBACK_HITS=$(grep -rn --include="*.ts" --include="*.tsx" \
  "dev-insecure-fallback\|insecure.default\|changeme\|CHANGE_ME" \
  "$ROOT/app" "$ROOT/lib" "$ROOT/components" 2>/dev/null || true)

if [ -n "$FALLBACK_HITS" ]; then
  FALLBACK_COUNT=$(echo "$FALLBACK_HITS" | wc -l)
  warn "$FALLBACK_COUNT occurrence(s) of insecure-fallback strings — verify production guards"
  echo "$FALLBACK_HITS" | head -10
else
  pass "No insecure fallback strings found"
fi

# ─── 5. XSS sinks ─────────────────────────────────────────────────────────────
header "5. XSS sinks (dangerouslySetInnerHTML, eval, innerHTML)"

XSS_HITS=$(grep -rn --include="*.ts" --include="*.tsx" \
  -E "dangerouslySetInnerHTML|\.innerHTML\s*=|eval\s*\(" \
  "$ROOT/app" "$ROOT/lib" "$ROOT/components" 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*//' || true)

if [ -n "$XSS_HITS" ]; then
  fail "Potential XSS sink(s) found:"
  echo "$XSS_HITS"
else
  pass "No XSS sinks (dangerouslySetInnerHTML / eval / innerHTML) found"
fi

# ─── 6. console.log in app code ───────────────────────────────────────────────
header "6. console.log in app code (lib/log.ts is the logger)"

CONSOLE_HITS=$(grep -rn --include="*.ts" --include="*.tsx" \
  "console\.log(" "$ROOT/app" "$ROOT/lib" "$ROOT/components" "$ROOT/middleware.ts" 2>/dev/null \
  | grep -v "//.*console\.log" || true)

if [ -n "$CONSOLE_HITS" ]; then
  CONSOLE_COUNT=$(echo "$CONSOLE_HITS" | wc -l)
  fail "$CONSOLE_COUNT console.log call(s) in app code — use log.info/warn/error from lib/log.ts"
  echo "$CONSOLE_HITS" | head -10
else
  pass "No console.log calls in app, lib, components or middleware"
fi

# ─── 7. TypeScript `any` in source ────────────────────────────────────────────
header "7. TypeScript 'any' usage"

ANY_HITS=$(grep -rn --include="*.ts" --include="*.tsx" \
  -E ": any\b|as any\b|<any>" \
  "$ROOT/app" "$ROOT/lib" "$ROOT/components" 2>/dev/null \
  | grep -v "//.*any" || true)

ANY_COUNT=$(echo "$ANY_HITS" | grep -c "." || true)
if [ "$ANY_COUNT" -gt 0 ]; then
  warn "$ANY_COUNT usage(s) of TypeScript 'any' — consider narrowing types"
  echo "$ANY_HITS" | head -10
else
  pass "No TypeScript 'any' usages found"
fi

# ─── 8. Undocumented env vars ─────────────────────────────────────────────────
header "8. Env vars used but not in validateEnv"

VALIDATED=$(grep -E "^\s+'[A-Z_]+'" "$ROOT/lib/validateEnv.ts" \
  | sed "s/.*'\([A-Z_]*\)'.*/\1/" | sort -u)

ALL_ENV=$(grep -rhn --include="*.ts" --include="*.tsx" \
  "process\.env\." "$ROOT/app" "$ROOT/lib" 2>/dev/null \
  | grep -oE "process\.env\.[A-Z_]+" | sed 's/process\.env\.//' \
  | grep -v "NODE_ENV\|NEXT_PUBLIC_\|VERCEL\|PORT\|PATH\|HOME\|USER" \
  | sort -u)

MISSING_FROM_VALIDATE=""
while IFS= read -r VAR; do
  if ! echo "$VALIDATED" | grep -qx "$VAR"; then
    MISSING_FROM_VALIDATE="$MISSING_FROM_VALIDATE\n  $VAR"
  fi
done <<< "$ALL_ENV"

if [ -n "$MISSING_FROM_VALIDATE" ]; then
  warn "Env vars used in code but absent from validateEnv (verify intentional):"
  echo -e "$MISSING_FROM_VALIDATE" | head -15
else
  pass "All non-public env vars are validated at startup"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Security scan complete${RESET}"
echo -e "  ${GREEN}PASS: $PASS${RESET}  ${YELLOW}WARN: $WARN${RESET}  ${RED}FAIL: $FAIL${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}FAIL items require immediate attention before merging.${RESET}"
  exit 1
fi

if [ "$WARN" -gt 0 ]; then
  echo -e "${YELLOW}WARN items should be reviewed — they may be intentional.${RESET}"
fi

exit 0
