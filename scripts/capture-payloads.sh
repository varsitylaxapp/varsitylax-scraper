#!/bin/bash
# Capture every API endpoint to a directory, for scripts/payload-diff.js.
#
# THIS FILE IS THE CAPTURE BASELINE. Its endpoint list defines what "no payload
# change" means — an endpoint absent from here is an endpoint whose regressions are
# invisible. When a route is added, add it HERE in the same commit, or the next
# payload-diff will silently not cover it.
#
# Covers v1 as well as v2. v1 is sunsetting (~Oct 2026) but is still the fallback for
# /schedule/team/:slug, so a change that breaks it breaks a live path.
#
# Spans three states and two seasons on purpose: Oregon (single-division, the
# regression baseline), Washington (multi-division, has playoff formats), Arizona
# (rankings-only — the capability-absent case, where several endpoints legitimately
# 404 or return empty and that emptiness is itself the thing being held stable), and
# 2027 (classifications but no rankings/schedule).
#
#   node src/api.js --target=staging &
#   ./scripts/capture-payloads.sh /tmp/before
#   ... change something ...
#   ./scripts/capture-payloads.sh /tmp/after
#   node scripts/payload-diff.js /tmp/before /tmp/after
#
# /api/v2/health is deliberately NOT captured: it carries live timestamps and would
# differ on every run, training the reader to ignore diffs.

set -euo pipefail
OUT="${1:?usage: capture-payloads.sh <outputDir>}"
HOST="${VLX_API:-localhost:3000}"
SEASON="${SEASON:-2026}"
mkdir -p "$OUT"

curl -sf -o /dev/null --max-time 5 "$HOST/api/v2/states" \
  || { echo "API not responding at $HOST — start it: node src/api.js --target=staging"; exit 1; }

grab() { curl -s "$HOST$1" > "$OUT/$2.json"; }

# ── v2, per state ────────────────────────────────────────────────────────────
for st in "" "&state=WA" "&state=AZ"; do
  tag=$(echo "$st" | tr -d '&=' | sed 's/state//'); tag=${tag:-OR}
  grab "/api/v2/rankings/laxnumbers?season=$SEASON$st" "v2_rank_ln_$tag"
  grab "/api/v2/rankings/laxpower?season=$SEASON$st"   "v2_rank_lp_$tag"
  grab "/api/v2/rankings/both?season=$SEASON$st"       "v2_rank_both_$tag"
  grab "/api/v2/teams?season=$SEASON$st"               "v2_teams_$tag"
  grab "/api/v2/schedule/all?season=$SEASON$st"        "v2_sched_all_$tag"
  grab "/api/v2/schedule/playoffs?season=$SEASON$st"   "v2_sched_po_$tag"
  grab "/api/v2/playoff-formats?season=$SEASON$st"     "v2_formats_$tag"
done

# ── v2, singletons and other seasons ────────────────────────────────────────
grab "/api/v2/states"                                          "v2_states"
grab "/api/v2/schedule/team/oes?season=$SEASON"                "v2_sched_team_oes"
grab "/api/v2/schedule/team/mount_si_wa?season=$SEASON&state=WA" "v2_sched_team_mountsi"
grab "/api/v2/teams?season=2027&state=WA"                      "v2_teams_2027_WA"
grab "/api/v2/playoff-formats?season=2027&state=WA"            "v2_formats_2027_WA"

# ── v1 (sunsetting, still the /schedule/team fallback) ──────────────────────
grab "/api/rankings/laxnumbers?season=$SEASON" "v1_rank_ln"
grab "/api/rankings/laxpower?season=$SEASON"   "v1_rank_lp"
grab "/api/rankings/both?season=$SEASON"       "v1_rank_both"
grab "/api/schedule/all?season=$SEASON"        "v1_sched_all"
grab "/api/schedule/playoffs"                  "v1_sched_po"
grab "/api/schedule/oes?season=$SEASON"        "v1_sched_oes"

echo "  captured $(ls "$OUT" | wc -l | tr -d ' ') payloads to $OUT"
