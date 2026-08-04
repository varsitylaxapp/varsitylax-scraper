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

# endpoint|expected-status|json-key|OPTIONAL minimum element count
#
# THE MINIMUM IS NOT OPTIONAL IN SPIRIT. Without it a check asserts only that a key
# EXISTS, so `{"games": []}` and `{"brackets": []}` sail through — which is exactly how
# five of the six Washington checks passed against a database with no Washington data in
# it. A gate that cannot tell empty from populated is not a gate.
# 404 is EXPECTED where a capability is real but the data is not yet there — Arizona has
# hasRankings:true and no snapshot. That is a designed state, not a failure.
CHECKS=(
  "/api/v2/states|200|states"
  "/api/v2/health|200|status"
  "/api/v2/teams?season=$SEASON|200|teams|41"
  "/api/v2/teams?season=$SEASON&state=WA|200|teams|70"
  "/api/v2/rankings/laxnumbers?season=$SEASON|200|rankings|41"
  "/api/v2/rankings/laxpower?season=$SEASON|200|rankings"
  "/api/v2/rankings/both?season=$SEASON|200|season"
  # AZ rankings: 404 until window #4-lite's backfill lands, 200 with 17 rows after.
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=AZ|200|rankings|15"
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=ID|200|rankings|28"
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=MT|200|rankings|5"
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=NV|200|rankings|13"
  "/api/v2/schedule/all?season=$SEASON|200|games|300"
  # Was |200|season — it asserted that a key called "season" existed and printed 2026, so it
  # could not fail no matter how many WA games were served, including none. Same class as the
  # five WA checks that passed against a database with no Washington data.
  "/api/v2/schedule/all?season=$SEASON&state=WA|200|games|500"
  "/api/v2/schedule/playoffs?season=$SEASON|200|games|38"
  "/api/v2/schedule/team/oes?season=$SEASON|200|games"
  "/api/v2/schedule/team/nope?season=$SEASON|404|error"
  # /playoff-formats is the ONLY endpoint that hard-fails on a missing playoff_formats
  # table. /schedule/playoffs does NOT: attachGraph catches its own errors by design, so
  # a missing table degrades it silently to a flat list. Without this line the rehearsal
  # gate passed against a schema HEAD genuinely cannot serve — the gap that proved the
  # smoke list itself needs the same "prove it can fail" discipline as everything else.
  "/api/v2/playoff-formats?season=$SEASON|200|brackets|2"
  "/api/v2/playoff-formats?season=$SEASON&state=AZ|200|season"
  # ── WASHINGTON. These FAIL until stage (c) / window #3 lands, deliberately: they are
  # the per-state launch gate. Prod today advertises WA as fully capable and serves an
  # empty state behind it, and a smoke list that stayed silent about that would be
  # describing the app we meant to ship rather than the one deployed.
  #   before window #3:  SMOKE_SKIP=state=WA ./scripts/prod-smoke.sh
  #   after:             drop the variable; WA is part of the contract.
  "/api/v2/rankings/laxnumbers?season=$SEASON&state=WA|200|rankings|70"
  "/api/v2/rankings/both?season=$SEASON&state=WA|200|season"
  "/api/v2/schedule/playoffs?season=$SEASON&state=WA|200|games|43"
  "/api/v2/playoff-formats?season=$SEASON&state=WA|200|brackets|4"
  "/api/v2/schedule/team/mount_si_wa?season=$SEASON|200|games|15"
  "/api/v2/teams?season=2027&state=WA|200|teams|70"
  # ── AZ / ID / MT / NV. FAIL until window #4-lite lands, deliberately — same role
  # the WA checks played before stage (c). Minimums pinned on staging 2026-08-03.
  #   before window #4:  SMOKE_SKIP=... or expect these four to fail
  "/api/v2/schedule/all?season=$SEASON&state=AZ|200|games|110"
  "/api/v2/schedule/all?season=$SEASON&state=ID|200|games|200"
  "/api/v2/schedule/all?season=$SEASON&state=MT|200|games|25"
  "/api/v2/schedule/all?season=$SEASON&state=NV|200|games|110"
  "/api/v2/teams?season=$SEASON&state=ID|200|teams|28"
  "/api/rankings/laxnumbers?season=$SEASON|200|rankings"
  "/api/schedule/all?season=$SEASON|200|games"
  "/api/schedule/playoffs|200|games"
)

# SMOKE_SKIP is a substring filter for endpoints a given deployment legitimately lacks.
# Live prod runs P5 code today, which predates /playoff-formats entirely and 404s it:
#   SMOKE_SKIP=playoff-formats ./scripts/prod-smoke.sh
# After window #2 ships, drop the variable — the route is part of the contract then.
SKIP="${SMOKE_SKIP:-}"

echo "  host: $HOST"
[ -n "$SKIP" ] && echo "  skipping endpoints matching: $SKIP"
echo
fail=0
for c in "${CHECKS[@]}"; do
  IFS='|' read -r path want key minimum <<< "$c"
  if [ -n "$SKIP" ] && [[ "$path" == *"$SKIP"* ]]; then
    printf "  skip  %-52s (SMOKE_SKIP)\n" "$path"; continue
  fi
  body=$(curl -s --max-time 25 "$HOST$path")
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$HOST$path")
  detail=$(printf '%s' "$body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('UNPARSEABLE'); raise SystemExit
k='$key'
if k not in d: print('MISSING KEY '+k); raise SystemExit
v=d[k]
lo='${minimum:-}'
if isinstance(v,(list,dict)):
    n=len(v)
    if lo and n < int(lo): print(f'TOO FEW {n} {k} (need {lo})'); raise SystemExit
    print(f'{n} {k}')
else:
    print(str(v)[:60])
" 2>/dev/null)
  if [ "$code" != "$want" ]; then
    printf "  FAIL  %-52s %s (want %s)  %s\n" "$path" "$code" "$want" "$(printf '%s' "$body" | head -c 70)"
    fail=$((fail+1))
  elif [ -z "$detail" ] || [[ "$detail" == MISSING* ]] || [[ "$detail" == UNPARSEABLE ]] || [[ "$detail" == TOO\ FEW* ]]; then
    printf "  FAIL  %-52s %s but %s\n" "$path" "$code" "${detail:-empty body}"
    fail=$((fail+1))
  else
    printf "  ok    %-52s %s  %s\n" "$path" "$code" "$detail"
  fi
done
echo
[ "$fail" -eq 0 ] && echo "  ${#CHECKS[@]}/${#CHECKS[@]} endpoints healthy" \
  || { echo "  $fail of ${#CHECKS[@]} endpoints FAILING"; exit 1; }
