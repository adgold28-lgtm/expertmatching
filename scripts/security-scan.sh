#!/usr/bin/env bash
# Automated security scan for ExpertMatch.
# Run: npm run security   (or: bash scripts/security-scan.sh)
#
# Checks:
#   1. npm audit — dependency CVEs
#   2. TypeScript compilation — tsc --noEmit
#   3. Hardcoded secrets — grep patterns
#   4. Insecure env-var fallbacks — dev-insecure-fallback outside contactCache
#   5. XSS sinks — dangerouslySetInnerHTML / eval / innerHTML
#   6. console.log in API routes — potential info leakage
#   7. TypeScript `any` usage — weakens type safety
#   8. Undocumented env vars — process.env references not in validateEnv

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

pass() { echo -e "${GREEN}  PASS${RESET}  $1"; ((PASS++)); }
fail() { echo -e "${RED}  FAIL${RESET}  $1"; ((FAIL++)); }
warn() { echo -e "${YELLOW}  WARN${RESET}  $1"; ((WARN++)); }
header() { echo -e "\n${BOLD}=== $1 ===${RESET}"; }

cd "$ROOT"

# ─── 1. npm audit ─────────────────────────────────────────────────────────────
header "1. Dependency vulnerabilities (npm audit)"

AUDIT_OUTPUT=$(npm audit --audit-level=high 2>&1 || true)
HIGH_COUNT=$(echo "$AUDIT_OUTPUT" | grep -c "high\|critical" || true)
if [ "$HIGH_COUNT" -gt 0 ]; then
  fail "npm audit reports HIGH/CRITICAL vulnerabilities — run 'npm audit' for details"
  echo "$AUDIT_OUTPUT" | tail -10
else
  TOTAL=$(npm audit 2>&1 | grep -E "^[0-9]+ vulnerabilit" | head -1 || echo "0 vulnerabilities")
  pass "No HIGH/CRITICAL CVEs found ($TOTAL)"
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
    | grep -v "\.env\.example\|\.env\.local\|\/\/ " || true)
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
  | grep -v "//.*dangerouslySetInnerHTML\|//.*innerHTML\|//.*eval" || true)

if [ -n "$XSS_HITS" ]; then
  fail "Potential XSS sink(s) found:"
  echo "$XSS_HITS"
else
  pass "No XSS sinks (dangerouslySetInnerHTML / eval / innerHTML) found"
fi

# ─── 6. console.log in API routes ─────────────────────────────────────────────
header "6. console.log in API routes (potential info leakage)"

CONSOLE_HITS=$(grep -rn --include="*.ts" \
  "console\.log" "$ROOT/app/api" 2>/dev/null \
  | grep -v "//.*console\.log" || true)

if [ -n "$CONSOLE_HITS" ]; then
  CONSOLE_COUNT=$(echo "$CONSOLE_HITS" | wc -l)
  warn "$CONSOLE_COUNT console.log call(s) in API routes — review for PII leakage"
  echo "$CONSOLE_HITS" | head -10
else
  pass "No console.log calls in API routes"
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
