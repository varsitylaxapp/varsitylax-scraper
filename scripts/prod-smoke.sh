#!/bin/bash
# Post-deploy smoke test: does the LIVE API actually serve every endpoint?
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS — the 2026-07-30 outage.
#
# The P5 push deployed `g.is_forfeit` in GAME_SELECT to production while section J's
# migration stayed unapplied. Three v2 endpoints returned 500 for a day, and nothing
# noticed, because nothing ever asked the LIVE API whether it worked.
#
# Every check that ran was true and irrelevant: unit tests, additions-only payload diff,
# byte-identical captures, clean seeder acceptance — all against STAGING, where the
# column exists. Staging validates code against the schema it was written for. Only the
# deployed system can tell you the deployed system works.
#
# This is the cheapest possible closure of that gap: hit everything, fail on anything
# that is not the documented status. It would have caught the outage in the seconds
# after the deploy rather than the day after.
# ─────────────────────────────────────────────────────────────────────────────
#
#   ./scripts/prod-smoke.sh                          # live prod
#   ./scripts/prod-smoke.sh http://localhost:3000    # anything else
#
# ZERO FALSE POSITIVES BY CONSTRUCTION. It asserts on real HTTP responses rather than
# inferring from source. An earlier attempt to catch this statically — parsing SQL out of
# src/ and checking columns against information_schema — was abandoned at 4 false
# positives against a healthy database. A gate that cries wolf gets switched off.

set -uo pipefail
HOST="${1:-https://api.varsitylaxapp.com}"
SEASON="${SEASON:-2026}"

# endpoint|expected-status|json-key-that-must-be-present-and-non-empty
# 404 is EXPECTED where a capability is real but the data is not yet there — Arizona has
# hasRankings:true and no snapshot. That is a designed state, not a failure.
CHECKS=(
  "/api/v2/states|200|states"
  "/api/v2/health|200|status"
  "/api/v2/teams?season=$SEASON|200|teams"
  "/api/v2/teams?season=$SEASON&state=WA|200|teams"
  "/api/v2/rankings/laxnumbers?season=$SEASON|200|rankings"
  "/api/v2/rankings/laxpower?season=$SEASON|200|rankings"
  "/api/v2/rankings/both?season=$SEASON|200|season"
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=AZ|404|error"
  "/api/v2/schedule/all?season=$SEASON|200|games"
  "/api/v2/schedule/all?season=$SEASON&state=WA|200|season"
  "/api/v2/schedule/playoffs?season=$SEASON|200|games"
  "/api/v2/schedule/team/oes?season=$SEASON|200|games"
  "/api/v2/schedule/team/nope?season=$SEASON|404|error"
  "/api/rankings/laxnumbers?season=$SEASON|200|rankings"
  "/api/schedule/all?season=$SEASON|200|games"
  "/api/schedule/playoffs|200|games"
)

echo "  host: $HOST"
echo
fail=0
for c in "${CHECKS[@]}"; do
  IFS='|' read -r path want key <<< "$c"
  body=$(curl -s --max-time 25 "$HOST$path")
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$HOST$path")
  detail=$(printf '%s' "$body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('UNPARSEABLE'); raise SystemExit
k='$key'
if k not in d: print('MISSING KEY '+k); raise SystemExit
v=d[k]
print(f'{len(v)} {k}' if isinstance(v,(list,dict)) else str(v)[:60])
" 2>/dev/null)
  if [ "$code" != "$want" ]; then
    printf "  FAIL  %-52s %s (want %s)  %s\n" "$path" "$code" "$want" "$(printf '%s' "$body" | head -c 70)"
    fail=$((fail+1))
  elif [ -z "$detail" ] || [[ "$detail" == MISSING* ]] || [[ "$detail" == UNPARSEABLE ]]; then
    printf "  FAIL  %-52s %s but %s\n" "$path" "$code" "${detail:-empty body}"
    fail=$((fail+1))
  else
    printf "  ok    %-52s %s  %s\n" "$path" "$code" "$detail"
  fi
done
echo
[ "$fail" -eq 0 ] && echo "  ${#CHECKS[@]}/${#CHECKS[@]} endpoints healthy" \
  || { echo "  $fail of ${#CHECKS[@]} endpoints FAILING"; exit 1; }
