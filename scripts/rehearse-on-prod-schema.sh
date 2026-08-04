#!/bin/bash
# GATE #5 — does HEAD's API boot and serve against PROD'S OWN SCHEMA?
#
# ═════════════════════════════════════════════════════════════════════════════
# WHY THIS EXISTS — the 2026-07-30 outage.
#
# The P5 push deployed `g.is_forfeit` in GAME_SELECT while section J's migration stayed
# unapplied. Three v2 endpoints returned 500 for a day.
#
# EVERY GREEN WAS TRUE AND IRRELEVANT. Unit tests, additions-only payload diff,
# byte-identical captures, clean seeder acceptance, clean Oregon regression — all of them
# ran against STAGING, where the column exists. Staging validates code against the schema
# the code was written FOR. Only prod's schema validates it against what prod HAS.
#
# "Rehearse at prod's sql_mode" was the specific rule. This is the general one:
# rehearse at prod's EVERYTHING. Run it at every phase exit, before any push.
# ═════════════════════════════════════════════════════════════════════════════
#
#   ./scripts/rehearse-on-prod-schema.sh                 # baseline: prod schema as-is
#   ./scripts/rehearse-on-prod-schema.sh --window2       # + window #2's migrations
#   ./scripts/rehearse-on-prod-schema.sh --window3       # + stage (c): Washington
#   ./scripts/rehearse-on-prod-schema.sh --window4       # + AZ/ID/MT/NV, INCLUDING DDL
#
# A FRESH DUMP EVERY RUN. A cached dump answers "did HEAD work against prod as it was
# whenever someone last looked", which is the question that produced the outage.
#
# Requires Docker (colima is fine) and mysql-client. Everything is local: no cloud
# resources, no cost, works offline once the image is pulled.

set -uo pipefail
cd "$(dirname "$0")/.."

WINDOW2=0
WINDOW3=0
[[ " $* " == *" --window2 "* ]] && WINDOW2=1
[[ " $* " == *" --window3 "* ]] && WINDOW3=1
WINDOW4=0
[[ " $* " == *" --window4 "* ]] && WINDOW4=1

# Window-3 expectations. Left blank on the FIRST rehearsal so the run PINS them; set
# from that run's output thereafter, so later runs assert rather than observe.
W3_TEAMS="${W3_TEAMS:-}"     ; W3_TEAMS27="${W3_TEAMS27:-}"
W3_GAMES="${W3_GAMES:-}"     ; W3_PO="${W3_PO:-}"
W3_RANK="${W3_RANK:-}"       ; W3_OR="${W3_OR:-}"

MYSQL_VERSION="8.0.41"            # prod's exact version — not "8.0", not "latest"
PROD_SQL_MODE="NO_ENGINE_SUBSTITUTION"   # prod (DreamHost). NOT Railway's STRICT default.
CONTAINER="vlx-rehearsal"
PORT=13306
ROOTPW="rehearsal"
WORK=$(mktemp -d)
API_PID=""

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
die() { printf '\n  \033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }

teardown() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  rm -rf "$WORK"
}
# Wired BEFORE anything is created, so a failure at any step still cleans up. A rehearsal
# that leaves a container holding a production dump behind is worse than no rehearsal.
trap teardown EXIT

command -v docker >/dev/null || die "docker not installed (brew install colima docker && colima start)"
docker info >/dev/null 2>&1 || die "docker daemon not running (colima start)"

# ── 1. fresh prod dump ───────────────────────────────────────────────────────
say "1. fresh prod dump  (READ ONLY)"
node -e "
require('dotenv').config();
const fs=require('fs');
fs.writeFileSync('$WORK/my.cnf','[client]\nhost='+process.env.DB_HOST+'\nuser='+process.env.DB_USER+
  '\npassword=\"'+process.env.DB_PASSWORD+'\"\n',{mode:0o600});
fs.writeFileSync('$WORK/dbname',process.env.DB_NAME);
" 2>/dev/null || die "could not read prod credentials from .env"
DBN=$(cat "$WORK/dbname")
echo "   source: prod (DB_HOST from .env)   database: $DBN"
mysqldump --defaults-extra-file="$WORK/my.cnf" \
  --single-transaction --quick --routines --triggers \
  --no-tablespaces --set-gtid-purged=OFF --column-statistics=0 \
  "$DBN" > "$WORK/prod.sql" 2>"$WORK/dump.err" || { cat "$WORK/dump.err"; die "mysqldump failed"; }
tail -2 "$WORK/prod.sql" | grep -q 'Dump completed' || die "dump has no terminator — truncated"
echo "   ✓ $(du -h "$WORK/prod.sql" | cut -f1), $(grep -c '^CREATE TABLE' "$WORK/prod.sql") tables, terminator present"

# DEFINER filter. mysqldump emits views as DEFINER=`prod_user`@`host`, and that user does
# not exist in the container, so the restore fails on the view with ERROR 1449.
sed -E 's/DEFINER=`[^`]*`@`[^`]*`//g' "$WORK/prod.sql" > "$WORK/restore.sql"
echo "   ✓ DEFINER clauses stripped: $(( $(grep -c 'DEFINER=' "$WORK/prod.sql") )) → $(grep -c 'DEFINER=' "$WORK/restore.sql")"

# ── 2. container at prod's exact version ─────────────────────────────────────
say "2. mysql:$MYSQL_VERSION container, fresh datadir"
docker rm -f "$CONTAINER" >/dev/null 2>&1
# No volume mounted: the datadir lives and dies with the container. That is deliberate —
# it makes "fresh volume" structural, and sidesteps the trap the runbook warns about,
# where a datadir initialised by 9.4 makes an 8.0 container crash-loop forever.
docker run -d --name "$CONTAINER" \
  -e MYSQL_ROOT_PASSWORD="$ROOTPW" -e MYSQL_DATABASE="$DBN" \
  -p "$PORT":3306 "mysql:$MYSQL_VERSION" >/dev/null || die "container did not start"

mysh() { docker exec -i "$CONTAINER" mysql -uroot -p"$ROOTPW" --default-character-set=utf8mb4 "$@" 2>/dev/null; }

# Wait on a REAL authenticated query, not `mysqladmin ping`. The MySQL image runs a
# TEMPORARY server during initialisation which answers ping before the root password is
# applied and before the real server listens — so ping-then-proceed races the init and
# fails intermittently. A successful SELECT is the only readiness signal that means what
# it says.
printf "   waiting for mysqld"
READY=0
for i in $(seq 1 120); do
  if mysh -N -e "SELECT 1" 2>/dev/null | grep -q 1; then READY=1; break; fi
  printf "."; sleep 2
done
echo
[ "$READY" = "1" ] || { echo; docker logs --tail 25 "$CONTAINER" 2>&1 | sed "s/^/     /"; die "mysqld never became ready"; }

VER=$(mysh -N -e "SELECT VERSION()")
echo "   SELECT VERSION() → $VER"
[[ "$VER" == "$MYSQL_VERSION"* ]] || die "expected $MYSQL_VERSION, got $VER — verify BEFORE restoring"

# ── 3. prod's sql_mode, set and VERIFIED ─────────────────────────────────────
say "3. sql_mode → prod's exact value"
mysh -e "SET GLOBAL sql_mode = '$PROD_SQL_MODE';"
GOT=$(mysh -N -e "SELECT @@GLOBAL.sql_mode")
echo "   container default was STRICT_TRANS_TABLES,... (Docker image default)"
echo "   SELECT @@GLOBAL.sql_mode → ${GOT:-<empty>}"
[ "$GOT" = "$PROD_SQL_MODE" ] || die "sql_mode is '$GOT', expected '$PROD_SQL_MODE' — a rehearsal at the wrong mode tests a different database"

# ── 4. restore — which also proves the dump is restorable ────────────────────
say "4. restore the prod dump"
mysh "$DBN" < "$WORK/restore.sql" || die "restore failed — the dump is NOT restorable"
T=$(mysh -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DBN'")
G=$(mysh -N -e "SELECT COUNT(*) FROM $DBN.games")
echo "   ✓ restored: $T tables/views, $G games"
[ "$G" -gt 0 ] || die "restore produced no games"

if [ "$WINDOW2" = "1" ]; then
  say "5. window #2 migrations"
  # J statements 1 and 6 are ALREADY on prod (emergency partial-J, 2026-07-30) and so are
  # already in the dump. Only 2-5 remain. They were verified as no-ops on prod; this is
  # where that claim gets executed rather than asserted.
  echo "   J (statements 2-5, the note= cleanup)"
  mysh "$DBN" -e "
    UPDATE games SET is_forfeit = 1 WHERE status_note = 'note=Forfeit';
    UPDATE games SET status_note = NULL WHERE status_note = 'note=Overtime';
    UPDATE games SET status_note = NULL WHERE status_note = 'note=Forfeit';
    UPDATE games SET status_note = SUBSTRING(status_note, 6) WHERE status_note LIKE 'note=%';
    SELECT ROW_COUNT() AS last_stmt_rows;" || die "J 2-5 failed"

  # K's ENUM change is the statement the sql_mode setting exists for.
  echo "   K (status ENUM + stale_exemptions + v_stale_watch)  ← the ENUM at non-strict"
  docker exec -i "$CONTAINER" mysql -uroot -p"$ROOTPW" "$DBN" < migrations/section-k-stale-fixtures.sql \
    || die "section K failed"
  echo "   L (playoff_formats + v_playoff_format_anchors)"
  docker exec -i "$CONTAINER" mysql -uroot -p"$ROOTPW" "$DBN" < migrations/section-l-playoff-formats.sql \
    || die "section L failed"

  export DB_TARGET=rehearsal
  export REHEARSAL_DATABASE_URL="mysql://root:$ROOTPW@127.0.0.1:$PORT/$DBN"
  say "6. backfills + OR-only format seed"
  node scripts/backfill-oregon-playoff-type.js --commit 2>&1 | grep -vE "^$" | tail -6 | sed 's/^/   /'
  node -e "
    const pool=require('./src/db');
    const {markStaleFixtures}=require('./src/stale-fixtures');
    (async()=>{ const r=await markStaleFixtures(pool,2026);
      console.log('   stale marked:',r.marked); await pool.end(); })();" 2>&1 | grep -v "^\[db\]"
  node scripts/seed-playoff-formats.js --state=OR --commit 2>&1 | grep -E "states:|assigned|seeded|COMMIT" | sed 's/^/   /'
fi

if [ "$WINDOW3" = "1" ]; then
  export DB_TARGET=rehearsal
  export REHEARSAL_DATABASE_URL="mysql://root:$ROOTPW@127.0.0.1:$PORT/$DBN"

  say "5. stage (c) — Washington promotion"
  echo "   pre-state (prod, WA):"
  mysh -N -e "SELECT CONCAT('     teams=', (SELECT COUNT(*) FROM $DBN.teams WHERE state='WA'),
    '  games=', (SELECT COUNT(*) FROM $DBN.games g JOIN teams h ON h.id=g.home_team_id
                  JOIN teams a ON a.id=g.away_team_id
                 WHERE g.season=2026 AND h.state='WA' AND a.state='WA'),
    '  formats=', (SELECT COUNT(*) FROM $DBN.playoff_formats WHERE state='WA'),
    '  rankings=', (SELECT COUNT(*) FROM $DBN.rankings_snapshots WHERE state='WA'))"

  echo "   a. roster + aliases + 2026 classifications + the 502-game season"
  node scripts/import-whsbla.js --commit 2>&1 | tail -14 | sed 's/^/     /'
  echo "   b. 2027 classifications"
  node scripts/import-whsbla-2027.js --commit 2>&1 | tail -6 | sed 's/^/     /'
  echo "   c. game_type adoption (exhibition/practice from the export)"
  node scripts/adopt-whsbla-game-types.js --commit 2>&1 | tail -6 | sed 's/^/     /'
  echo "   d. WA rankings one-off backfill"
  node scripts/scrape-state-rankings.js WA --commit 2>&1 | tail -6 | sed 's/^/     /'
  echo "   e. WA playoff formats — the stage-(c) seeder invocation, by name"
  node scripts/seed-playoff-formats.js --state=WA --commit 2>&1 \
    | grep -E "states:|final #|assigned|seeded|COMMIT|ROLLED" | sed 's/^/     /'
fi

# ── 6b. GUARD DRY-RUN — the one path rehearsal structurally cannot exercise ──
#
# Rehearsal runs at target=REHEARSAL, so every prod-refusal guard in these scripts is
# skipped by construction. That is exactly how window #3 met an unknown guard live: three
# importers refused prod outright and the refusal could not have surfaced in any rehearsal
# that came before it.
#
# So: invoke each script the way the WINDOW will invoke it — same flags, against PROD —
# but WITHOUT --commit, so target resolution and guard behaviour are exercised and nothing
# is written. A script that would refuse the window refuses here instead.
if [ "$WINDOW3" = "1" ]; then
  say "6b. guard dry-run — exact prod invocations, no --commit"
  GUARD_FAIL=0
  for inv in "import-whsbla.js --stage-c" \
             "import-whsbla-2027.js --stage-c" \
             "adopt-whsbla-game-types.js" \
             "scrape-state-rankings.js WA --stage-c" \
             "seed-playoff-formats.js --state=WA"; do
    # no DB_TARGET => prod, which is what the window uses. No --commit => no writes.
    out=$(cd "$(dirname "$0")/.." && env -u DB_TARGET -u REHEARSAL_DATABASE_URL \
            node scripts/$inv 2>&1 | grep -iE "FATAL|only runs against|refus" | head -1)
    if [ -n "$out" ]; then
      printf "   BLOCKED  %-42s %s\n" "${inv%% *}" "$out"; GUARD_FAIL=$((GUARD_FAIL+1))
    else
      printf "   ok       %-42s accepts the window's invocation\n" "${inv%% *}"
    fi
  done
  [ "$GUARD_FAIL" -eq 0 ] || { echo "   → $GUARD_FAIL script(s) would refuse the window"; SMOKE=1; }
fi

if [ "$WINDOW4" = "1" ]; then
  export DB_TARGET=rehearsal
  export REHEARSAL_DATABASE_URL="mysql://root:$ROOTPW@127.0.0.1:$PORT/$DBN"

  say "5. window #4-lite — AZ/ID/MT/NV"
  # THE DDL RUNS HERE, at prod's sql_mode, not just the data. Section M is a MODIFY
  # COLUMN on a CHAR(2) NOT NULL, and a column-modifying statement is exactly the class
  # that behaves differently under a different mode — the reason this gate exists.
  echo "   a. section-m — teams.state becomes nullable (DDL, at prod sql_mode)"
  docker exec -i "$CONTAINER" mysql -uroot -p"$ROOTPW" "$DBN" < migrations/section-m-nullable-team-state.sql \
    || die "section M failed"
  NULLABLE=$(mysh -N -e "SELECT IS_NULLABLE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='$DBN' AND TABLE_NAME='teams' AND COLUMN_NAME='state'")
  echo "      teams.state IS_NULLABLE → $NULLABLE"
  [ "$NULLABLE" = "YES" ] || die "section M did not take"

  echo "   b. roster + games for the four states"
  node scripts/import-laxnumbers-games.js --state=AZ,ID,MT,NV --commit 2>&1 \
    | grep -E "roster —|imported|UNEXPLAINED|COMMITTED|ROLLED|UNRESOLVED" | sed 's/^/     /'
fi

# ── 7. HEAD's API, booted against this schema ────────────────────────────────
say "$([ "$WINDOW2" = 1 ] && echo 7 || echo 5). boot HEAD's API against the rehearsal schema"
export DB_TARGET=rehearsal
export REHEARSAL_DATABASE_URL="mysql://root:$ROOTPW@127.0.0.1:$PORT/$DBN"
node src/api.js > "$WORK/api.log" 2>&1 &
API_PID=$!
for i in $(seq 1 40); do curl -sf -o /dev/null --max-time 2 localhost:3000/api/v2/states && break; sleep 0.5; done
grep -m1 "^\[db\]" "$WORK/api.log" | sed 's/^/   /'
curl -sf -o /dev/null --max-time 3 localhost:3000/api/v2/states || { tail -20 "$WORK/api.log"; die "API did not boot"; }

# ── 8. the actual gate ───────────────────────────────────────────────────────
say "$([ "$WINDOW2" = 1 ] && echo 8 || echo 6). prod-smoke.sh against HEAD on prod's schema"
./scripts/prod-smoke.sh http://localhost:3000
SMOKE=$?

# ── 9. the written expected diff, asserted ───────────────────────────────────
if [ "$WINDOW2" = "1" ]; then
  say "9. RELEASE.md's written expected diff — reproduced or not"
  EXPECT_FAIL=0
  chk() {  # label | actual | expected
    if [ "$2" = "$3" ]; then printf "   ok    %-46s %s\n" "$1" "$2"
    else printf "   FAIL  %-46s %s (expected %s)\n" "$1" "$2" "$3"; EXPECT_FAIL=$((EXPECT_FAIL+1)); fi
  }
  j() { curl -s --max-time 20 "http://localhost:3000$1" | python3 -c "import json,sys;d=json.load(sys.stdin);$2"; }

  chk "Oregon schedule/all: 354 -> 345"  "$(j '/api/v2/schedule/all?season=2026' 'print(len(d["games"]))')" "345"
  chk "playoff-formats is a NEW endpoint" "$(j '/api/v2/playoff-formats?season=2026' 'print(len(d["brackets"]))')" "2"
  chk "schedule/playoffs gains bracketKey" "$(j '/api/v2/schedule/playoffs?season=2026' 'print(sum(1 for g in d["games"] if g.get("bracketKey")))')" "38"
  chk "schedule/playoffs gains round"      "$(j '/api/v2/schedule/playoffs?season=2026' 'print(sum(1 for g in d["games"] if g.get("round") is not None))')" "38"
  chk "schedule/playoffs gains advancesTo" "$(j '/api/v2/schedule/playoffs?season=2026' 'print(sum(1 for g in d["games"] if g.get("advancesTo")))')" "36"
  chk "isForfeit present (0 true in OR)"   "$(j '/api/v2/schedule/all?season=2026' 'print(sum(1 for g in d["games"] if "isForfeit" in g))')" "345"
  chk "dateKey present on every game"      "$(j '/api/v2/schedule/all?season=2026' 'print(sum(1 for g in d["games"] if g.get("dateKey")))')" "345"
  chk "rankPosition present on every row"  "$(j '/api/v2/rankings/laxnumbers?season=2026' 'print(sum(1 for r in d["rankings"] if r.get("rankPosition")))')" "41"
  chk "playoffSource is game_type now"     "$(j '/api/v2/schedule/playoffs?season=2026' 'print(d["playoffSource"])')" "game_type"
  chk "both Oregon finals, one day"        "$(j '/api/v2/schedule/playoffs?season=2026' 'print(len({g["dateKey"] for g in d["games"] if g.get("round")==0}))')" "1"
  [ "$EXPECT_FAIL" -eq 0 ] || SMOKE=1
fi

if [ "$WINDOW3" = "1" ]; then
  say "9. stage (c) expected diff — pinned by REHEARSAL, not by arithmetic"
  W3_FAIL=0
  c3() { if [ "$2" = "$3" ]; then printf "   ok    %-44s %s\n" "$1" "$2"
         else printf "   FAIL  %-44s %s (expected %s)\n" "$1" "$2" "$3"; W3_FAIL=$((W3_FAIL+1)); fi; }
  j3() { curl -s --max-time 25 "http://localhost:3000$1" | python3 -c "import json,sys;d=json.load(sys.stdin);$2"; }

  echo "   WASHINGTON — empty/404 before, populated after:"
  c3 "teams 2026"        "$(j3 '/api/v2/teams?season=2026&state=WA' 'print(len(d["teams"]))')" "$W3_TEAMS"
  c3 "teams 2027"        "$(j3 '/api/v2/teams?season=2027&state=WA' 'print(len(d["teams"]))')" "$W3_TEAMS27"
  c3 "schedule/all"      "$(j3 '/api/v2/schedule/all?season=2026&state=WA' 'print(len(d["games"]))')" "$W3_GAMES"
  c3 "schedule/playoffs" "$(j3 '/api/v2/schedule/playoffs?season=2026&state=WA' 'print(len(d["games"]))')" "$W3_PO"
  c3 "rankings"          "$(j3 '/api/v2/rankings/laxnumbers?season=2026&state=WA' 'print(len(d["rankings"]))')" "$W3_RANK"
  c3 "playoff-formats"   "$(j3 '/api/v2/playoff-formats?season=2026&state=WA' 'print(str(d["declared"])+"/"+str(d["resolved"]))')" "4/4"
  echo "   OREGON — changes only by the policy-accepted cross-border rows:"
  c3 "schedule/all OR"   "$(j3 '/api/v2/schedule/all?season=2026' 'print(len(d["games"]))')" "$W3_OR"
  c3 "playoffs OR"       "$(j3 '/api/v2/schedule/playoffs?season=2026' 'print(len(d["games"]))')" "38"
  c3 "formats OR"        "$(j3 '/api/v2/playoff-formats?season=2026' 'print(str(d["declared"])+"/"+str(d["resolved"]))')" "2/2"
  c3 "rankings OR"       "$(j3 '/api/v2/rankings/laxnumbers?season=2026' 'print(len(d["rankings"]))')" "41"
  [ "$W3_FAIL" -eq 0 ] || SMOKE=1
fi

say "teardown"
kill "$API_PID" 2>/dev/null; API_PID=""
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker ps -a --filter "name=$CONTAINER" --format '{{.Names}}' | grep -q . \
  && die "container still present after teardown" || echo "   ✓ container removed, dump deleted"

[ "$SMOKE" -eq 0 ] || die "HEAD does NOT serve correctly against prod's schema"
printf '\n  \033[32mGATE PASSED — HEAD boots and serves against prod'"'"'s schema at prod'"'"'s sql_mode\033[0m\n\n'
