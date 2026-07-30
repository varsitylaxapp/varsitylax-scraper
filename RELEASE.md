# Release plan — Phase F multi-state schema

**Status: APPROVED. Stage (a) PASSED 2026-07-28. All pre-flight items closed.
Awaiting Spencer's window announcement. No push has occurred. No prod migration
has occurred.**

> **A SECOND WINDOW NOW EXISTS.** Window #2 (playoff graph, stale fixtures, forfeits)
> is drafted below and is a **prerequisite of the TestFlight milestone** — without it
> Oregon's Playoffs tab is empty for testers. Read both before scheduling either.

Sixteen commits sit unpushed on `main`. This is one **coupled** release: the
code at HEAD requires the Section F, F2, F3, F4 and G schema, and the schema is inert without the code.
Pushing alone would deploy migration-dependent code against an unmigrated prod
database. Sequencing is the whole point of this document.

---

## 🔴 The blocking hazard: old code cannot write to the new schema

Verified on staging, not reasoned about:

```
INSERT INTO rankings_snapshots (source, season, captured_at, content_hash) ...
  ERROR 1364 (HY000): Field 'state' doesn't have a default value

INSERT INTO unresolved_aliases (raw_name, source, context, occurrence_count) ...
  ERROR 1364 (HY000): Field 'state' doesn't have a default value
```

Section F's steps F5/F7 add `state` as `NOT NULL` and then **drop the default**, so any
pre-Phase-F writer that omits the column fails outright. `varsitylax-cron` runs
**every 2 hours**, so a migrate-then-deploy gap of even one cycle produces failed
scrapes.

**Reads are unaffected.** Every v1 and v2 API route is a `SELECT` with an
explicit column list, so the old API serves the new schema correctly. Only the
cron writes.

That asymmetry gives a clean window: **stop the cron, migrate, deploy, restart
the cron — the API never goes down.**

### Two options

| | **A — cron pause (recommended)** | **B — deferred default drop** |
|---|---|---|
| Method | Stop `varsitylax-cron`, migrate, push, restart | Migrate keeping `DEFAULT 'OR'` on the two columns; push; drop defaults in a follow-up migration |
| Scrape downtime | one cycle (~2h), offseason | none |
| API downtime | none | none |
| Risk | a forgotten restart | the guard is weakened until the follow-up lands, and follow-ups get forgotten |

**Recommend A.** It is the offseason, rankings have not changed since
2026-07-11, and a missed cycle costs nothing. B trades a real safety property
for downtime we do not need to avoid.

---

> **Migration file naming.** `section-f-multistate.sql` has internal steps
> labelled F1–F8. The *separate files* `section-f2/f3/f4` and `section-g` are
> distinct migrations. Where this doc says "step F5" it means a step inside
> section-f; where it says "section-f2" it means the file.

## Stage (a) — MySQL 8.0 rehearsal ⛔ GATE

Everything so far was proven on **staging MySQL 9.4.0**. Prod is **8.0.41**.
Nothing in the DDL is 9.x-only, but "runs clean on 9.4" is not proof for 8.0.41.

1. Temp Railway service pinned to **`mysql:8.0.41`** — prod's exact version.

   ⚠️ **DO NOT create Railway's MySQL template service and then switch its image
   to 8.0.** The template boots 9.4 first and initializes the volume's datadir
   at that version. **MySQL cannot downgrade a datadir**, so the 8.0 container
   will crash-loop on that volume forever, and the failure looks like a Railway
   problem rather than a version problem.

   Instead: create a **Docker-image service from scratch**, pinned to
   `mysql:8.0.41`, with a **fresh volume**. If a volume was already initialized
   at 9.4, wipe it before converting.

   **Verify `SELECT VERSION()` returns 8.0.41 BEFORE restoring anything.**
   Delete the service once the rehearsal is captured.
2. Fresh `mysqldump` of prod → restore through the definer-stripping filter:
   ```
   sed -E 's/DEFINER=`[^`]*`@`[^`]*`//g; s/SQL SECURITY DEFINER/SQL SECURITY INVOKER/g'
   ```
3. Apply in order: `section-f` → `f2` → `f3` → `f4` → `g`. Every statement
   must exit 0.
4. Watch specifically:
   - **section-f steps F5/F6/F7** — combined `DROP INDEX … ADD UNIQUE KEY` in one `ALTER`
   - **section-f step F4** — `CHANGE COLUMN division division_id`, narrowing 64 → 16
   - **section-f2** — `alias_normalized` STORED GENERATED re-evaluation — 0 collisions
     expected, any duplicate aborts the ALTER
   - **section-f3** — `v_team_season_record` replacement — W-L checksum must not move
5. Run `scripts/capture.sh` before/after → **95/95 byte-identical**.
6. Confirm the ERROR 1364 hazard reproduces on 8.0 (it should — it is standard
   strict-mode behaviour, and the plan depends on knowing it).

**Gate: do not proceed to (b) until every step passes.**

### ✅ Stage (a) result — 2026-07-28

Executed on a from-scratch `mysql:8.0.41` Docker service, no volume attached
(so the datadir hazard above could not apply). TCP proxy created via the
GraphQL API, since the CLI exposes no TCP command. Service deleted afterwards.

```
SELECT VERSION()                       8.0.41   (verified BEFORE any restore)
dump 475,373 B, 1 DEFINER -> stripped  restore exit 0, view readable (70 rows)
f -> f2 -> f3 -> f4 -> g               all five exit 0, no stderr
W-L checksum across the view swap      f3f91c6319107224 -> f3f91c6319107224
alias collisions / state drift         0 / 0
ERROR 1364 reproduced on 8.0.41        both tables; new code with state: OK
sql_mode                               STRICT present, matches prod
95/95 capture diff vs 9.4.0 baseline   93 identical, 2 differ (health timestamps)
byte totals                            636,979 == 636,979
capture determinism (run twice)        identical
```

**MySQL 8.0.41 and 9.4.0 produce byte-identical Oregon output from the same prod
snapshot.** The version gap is closed with evidence.

The first capture attempt was discarded: an inline rewrite of the harness
dropped the readiness `sleep`, so it raced and collected 86/95, and renamed
output files made the diff meaningless. Harness bugs, not migration problems —
redone with the real `capture.sh`, and only the redone numbers count.

---

## Stage (b) — production window

Offseason, any quiet morning. Not immediately after a cron cycle — start just
*after* one completes to maximise headroom.

```
 1. Fresh full mysqldump of prod, verified restorable      [rollback anchor]
 2. Capture prod baseline via scripts/capture.sh            [before/]
 3. STOP the varsitylax-cron service                        ← window opens
 4. Apply section-f, f2, f3, f4, g to prod
 5. Run db/migrate verification queries — all invariants green
 6. git push  (auto-deploys varsitylax-api + varsitylax-cron)
      ⚠️ This restarts varsitylax-api too. Expect a brief API blip (~30-60s
      Railway container replacement) INSIDE the window. An UptimeRobot alert
      here is EXPECTED, not an incident — see "Monitoring during the window".
 7. Confirm both services boot; check the [db] target=PROD line
 8. RESTART varsitylax-cron                                 ← window closes
 9. Capture prod again → diff against step 2
10. Watch one full cron cycle: scrape_log rows must be status=success
```

### Expected diff at step 9

| Endpoint | Expectation |
|---|---|
| all rankings, teams, per-team schedules | **byte-identical** |
| `/health`, `/api/v2/health` | timestamps only |
| `schedule/all`, `schedule/playoffs` | **byte-identical** |

The `+6` schedule rows seen on staging **will not appear** — prod has no
Washington data until the importer is run there, which is stage (c).

### Monitoring during the window

UptimeRobot pings `/api/rankings/laxnumbers` every 5 minutes as the pre-warm
mechanism (shipped with v1.6.0). The step-6 redeploy replaces the API container,
so one ping may land during the restart.

**CLOSED BY RULING, 2026-07-28 (Spencer).** Free plan; the alert threshold is
unverified and that is accepted. A page during step 6 is **anticipated and
ignorable**. It was never verified — recorded as a decision, not as a fact, so
nobody later mistakes it for something that was checked.

Either way: **announce the window before starting**, so an alert mid-window
reads as expected. And note the pre-warm ping itself will re-warm the pool on
its next cycle — no manual warm-up needed.

### Rollback

- **Before step 6:** apply `section-f-rollback.sql`, restart cron. Old code, old
  schema, no deploy happened.
- **After step 6:** `git revert` the range and redeploy, then roll the schema
  back. Rollback is only safe while no non-Oregon rows exist — the rollback
  script's own preconditions check this.
- **Anything unclear:** restore the step-1 dump. It is the anchor.

---

## Runbook notes — learned the hard way, 2026-07-28

### ⚠️ prod sql_mode ≠ staging sql_mode

```
prod (DreamHost)          NO_ENGINE_SUBSTITUTION          <- NO STRICT
staging (Railway MySQL)   ...STRICT_TRANS_TABLES...
rehearsal (mysql:8.0.41)  ...STRICT_TRANS_TABLES...       <- Railway default
```

Same MySQL version, different mode. **A rehearsal that does not match prod's
`sql_mode` is testing a different database.** The 8.0.41 rehearsal reported
`ERROR 1364` for a missing `state`; prod silently wrote `state = ''` instead —
and because every read filters `AND state = ?`, such rows are invisible to the
API. Rankings would look frozen while `scrape_log` reported success.

**Every future rehearsal must run `SET GLOBAL sql_mode = '<prod's value>'`
immediately after boot, before restoring anything.** Verify with
`SELECT @@GLOBAL.sql_mode`, not by assumption.

Mitigated by section-h (CHECK constraints, enforced regardless of sql_mode) and
by `src/db.js`, which now sets `SESSION sql_mode` to include
`STRICT_TRANS_TABLES` on every pooled connection — the app carries strict mode
to whatever host it lands on. Both were verified independently on a
deliberately non-strict instance.

### ⚠️ Railway cron fires in UTC

`0 */2 * * *` runs at even **UTC** hours, which are **odd Pacific** hours
(1,3,5,…,23 local). During the 2026-07-28 window a watcher was pointed at
"14:00" and correctly saw nothing — there is no scheduled slot at an even
Pacific hour. Compute the next fire in UTC, or read it off `scrape_log`:

```sql
SELECT HOUR(scraped_at), COUNT(*) FROM scrape_log
WHERE source='laxnumbers-v2' GROUP BY 1 ORDER BY 1;
```

### ⚠️ Clearing `cronSchedule` does NOT stop the service

`serviceInstanceUpdate(input:{cronSchedule:null})` converts the cron job into a
**regular service**. It stops firing on a schedule, but the next deploy
**starts it immediately**. On 2026-07-28 the step-6 push triggered a full scrape
inside what was described as a paused window. It was harmless — the run used the
newly deployed code — but the pause was not what it appeared to be.

If a genuine stop is required, remove the deployment or scale to zero replicas.
For a migrate-then-deploy window, clearing the schedule is *sufficient* (it
prevents a scheduled run in the dangerous gap), but understand that the deploy
itself will trigger one run with the NEW code.

Note `index.js` exits after one pass and `restartPolicyType = NEVER`, so that
triggered run terminates rather than looping.

### ⚠️ Every prod probe runs in a transaction

A bare `INSERT` used as a "this should fail" probe **succeeded** on prod and
wrote a garbage row (removed, verified). A should-fail probe is exactly the case
where the environment surprises you. `START TRANSACTION` … `ROLLBACK`, always,
no exceptions.

---

## 🚨 Emergency partial-J — 2026-07-30, outage remediation

**Applied to production outside a scheduled window, on Spencer's explicit authorisation.**

### What was broken

Three v2 endpoints returned HTTP 500 for approximately one day:

```
GET /api/v2/schedule/all         500  {"error":"Unknown column 'g.is_forfeit' in 'field list'"}
GET /api/v2/schedule/playoffs    500  same
GET /api/v2/schedule/team/:slug  500  same
```

`states`, `health`, `teams` and all `rankings/*` were unaffected — they do not use
`GAME_SELECT`. Every v1 endpoint was healthy throughout. The cron kept writing
successfully; this was a read-path break only.

### Cause

Commit `3607fa8` (the P5 push, 2026-07-29) put section J's **code** on prod —
`g.is_forfeit` inside `GAME_SELECT`, which backs every game endpoint — while section J's
**migration** stayed unapplied. `git push` auto-deploys `varsitylax-api`, so the code
shipped the moment the branch moved.

### User impact: none, by luck

The shipped 1.6.0 lineage (`c4a2002`) routes every request through
`APIClient.fetchWithFallback`, which by its own contract falls back to v1 on "ANY failure
(transport error, non-2xx status, or decode failure)". v1 was healthy, so Oregon users
were transparently served v1 data for a day, in the offseason.

**That safety net no longer exists.** P2 shrank the fallback to `/schedule/team/:slug`
alone — correctly, because v1 cannot serve rankings or playoffs by construction. The same
incident after the next App Store release would be fully user-visible.

### What was applied

Section J statements **1 and 6 only**, verbatim, nothing added or altered:

```sql
ALTER TABLE games ADD COLUMN is_forfeit BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE games ADD KEY idx_games_forfeit (season, is_forfeit);
```

Section J's statements 2–5 (the forfeit backfill and `note=` cleanup) were **not**
applied and were verified to be no-ops on prod at the time: `note=Forfeit` 0 rows,
`note=Overtime` 0 rows, `status_note LIKE 'note=%'` 0 rows. Those artifacts are
WHSBLA-only and prod holds no Washington games. Window #2 must still run them, and must
tolerate the column and index already existing.

Rollback anchor: full `mysqldump` taken immediately before, 516K, 18 base tables + 1
view, terminator present, per-table row counts verified against prod's live catalogue
(`games` 354, `team_aliases` 193). **Restorability was NOT verified** — this machine has
`mysql-client` only, no server binary and no Docker, so no restore target existed. The
change is one additive column with a trivial inverse, which is why it proceeded anyway;
the gap is recorded rather than glossed.

Prod `sql_mode` confirmed at the time: `NO_ENGINE_SUBSTITUTION` (no STRICT), as the
runbook warns.

### Verification

All three endpoints returned 200 with real payloads immediately after; `schedule/all`
354 games, `schedule/playoffs` 38, `schedule/team/oes` 18. Full sweep via
`./scripts/prod-smoke.sh`: **16/16 endpoints healthy**. `isForfeit` appears appended
last, 0 true across 354 Oregon games — the planned additive change, arriving early and
landing additively.

---

## 🔬 Postmortem — why every green was true and it broke anyway

**Every check passed, and every check was irrelevant.** Before the P5 push: unit tests
green, payload diff additions-only, capture baseline byte-identical, seeder acceptance
clean, Oregon regression gate clean. All of them true. All of them run against
**staging**, where `is_forfeit` exists.

Staging validates code against the schema the code was written for. That is a real and
useful question. It is not the question that matters at push time, which is: **does this
code run against the schema production actually has?** Nothing asked that, so nothing
answered it — and the additive-payload machinery, which is genuinely good at what it
does, gave a confident green that was about a different database.

The failure is structural, not an oversight. A migration-coupled release has two halves
that can be deployed independently, and every guard we had watched one half.

### What closes it

1. **`./scripts/prod-smoke.sh` — post-deploy, mandatory.** Hits all 16 endpoints on the
   live host and fails on anything that is not the documented status. It asserts on real
   HTTP responses, so it has zero false positives by construction, and it would have
   caught this within seconds of the deploy rather than a day later. Proven able to fail
   (16/16 FAIL against a dead host).
2. **Pre-push schema rehearsal — HEAD's API booted against a restored prod dump.** The
   stronger gate, and the one this postmortem really demands: not staging, prod's own
   schema. It catches what a smoke test can only catch *after* deploying.
   **BLOCKED: requires a MySQL server.** This machine has `mysql-client` only — no
   `mysqld`, no Docker. Installing one is a prerequisite for this gate AND for window
   #2's `mysql:8.0.41` rehearsal, which is blocked for the same reason.
3. **A static SQL/schema conformance checker was attempted and abandoned.** Parsing SQL
   out of `src/` and checking columns against `information_schema` reached 4 false
   positives against a healthy database after two rounds of tightening — it matched
   JavaScript property access and prose in comments. Recorded so nobody rebuilds it: a
   gate that cries wolf gets switched off, which is worse than no gate.

### The rule

**A phase exit may not push migration-coupled code until it has been run against prod's
schema, not staging's.** "Rehearse at prod's `sql_mode`" was the specific case; this is
the general one.

---

## Window #2 — playoff graph, stale fixtures, forfeits

**Status: DRAFT, awaiting Spencer's window. Nothing pushed. No prod migration.**

Seven commits sit unpushed on `main` (`e73f216`…`27f179d`). Like window #1 this is one
**coupled** release: the code at HEAD requires sections J, K and L, and the schema is
inert without the code.

### 🔴 Why this cannot be a bundle-push

`git push` auto-deploys `varsitylax-api` (step 6 of stage (b) records this). HEAD's
`GAME_SELECT` — which backs **every** game endpoint, not just the new playoff routes —
selects `g.is_forfeit`, a column prod does not have. `src/api-v2.js` also references
`playoff_formats` (5×) and `status = 'stale'` (4×).

Pushing without migrating first does not degrade the playoff features. It **500s the
entire v2 API** for the shipped Oregon app. That is the same hazard window #1 was written
to sequence, with three more sections in it.

### 🔗 This is a PREREQUISITE of the TestFlight milestone

The P7 TestFlight build points Release at **prod**. The new bracket renderer takes its
structure from `bracketKey` / `round` / `advancesTo` and its bracket names from
`/api/v2/playoff-formats`. Without this window, **Oregon's Playoffs tab is empty for
testers** — not degraded, empty, because `buildBrackets` no longer exists to fall back to.

So window #2 slots **before or alongside** the app release. It is not housekeeping.
Stage (c) (Washington content) remains separate and is not required for TestFlight.

### What ships

| # | change | kind |
|---|---|---|
| 1 | `section-j-forfeit-and-note-cleanup.sql` | schema + backfill — ⚠️ **statements 1 and 6 are ALREADY APPLIED** (emergency partial-J, above). Run statements 2–5 only, or make the file idempotent first. Re-running `ADD COLUMN` as-is will ERROR 1060. |
| 2 | `section-k-stale-fixtures.sql` | schema (enum, `stale_exemptions`, `v_stale_watch`) |
| 3 | `section-l-playoff-formats.sql` | schema (`playoff_formats`, `v_playoff_format_anchors`) |
| 4 | `scripts/backfill-oregon-playoff-type.js --commit` | data — types Oregon's 38 completed playoff games |
| 5 | stale backfill (`markStaleFixtures`) | data — marks 9 Oregon fixtures `stale` |
| 6 | `scripts/seed-playoff-formats.js --commit` | data — 6 brackets, natural-key anchors |
| 7 | `dateKey` + `rankPosition` additive keys | code — **not yet written**; see below |
| 8 | `git push` → deploys api + cron | code |

Items 4–6 are **idempotent and dry-run by default**; each has been exercised on staging.
Item 7 is the two contract warts (`docs/api-contract.md` §1.3, §1.4) approved as additive
fixes. They must be written, payload-diffed and baseline-reset **before** the window, not
during it — a window is for executing a rehearsed plan, not authoring code.

### Requirements carried from window #1

These are not optional and each exists because window #1 nearly failed on it.

1. **Rehearsal on `mysql:8.0.41` AT PROD'S `sql_mode`.** Prod (DreamHost) runs
   `NO_ENGINE_SUBSTITUTION` — **no STRICT**. Railway and the rehearsal container default
   to `STRICT_TRANS_TABLES`. Same version, different mode, different database.
   `SET GLOBAL sql_mode = '<prod's value>'` immediately after boot, verified with
   `SELECT @@GLOBAL.sql_mode`, **before restoring anything**. Section K modifies a
   status ENUM — exactly the DDL class where mode differences bite.
2. **UTC-aware cron timing.** The cron runs every 2 hours; the container runs UTC while
   the DB stores Pacific wall-clock. Compute the next cycle in UTC and open the window
   just *after* one completes. Do not reason in local time.
3. **Every prod probe inside a transaction with an explicit rollback** — no exceptions,
   including probes that "should fail".
4. **Never filter the `[db]` boot line.** Use `./scripts/staging` for anything aimed at
   staging; prod is reached only by deliberately omitting it. (Added after 2026-07-30,
   when suppressed boot lines made prod reads look like staging reads.)

### Written expected diff

Captured before and after with `scripts/capture-payloads.sh`, diffed with
`scripts/payload-diff.js` against `payload-baseline/`. Three changes are expected and
**everything else must be byte-identical**.

| # | endpoint | expected change | user-visible? |
|---|---|---|---|
| 1 | `/api/v2/schedule/all?state=OR` | **354 → 345 games** (−9) | **YES — see below** |
| 2 | `/api/v2/schedule/playoffs` | gains `bracketKey`, `round`, `advancesTo` on every game | yes, enables the feature |
| 3 | `/api/v2/playoff-formats` | **new endpoint**, previously 404 | yes, enables the feature |
| 4 | all game endpoints | ~~gain `isForfeit`~~ — **already landed** 2026-07-30 with emergency partial-J | none |
| 5 | `/rankings/*` | gains `rankPosition` alongside `rank_position` | no |
| 6 | all game endpoints | gain `dateKey` | no |
| — | rankings order/content, `/teams`, `/states`, per-team schedules | **byte-identical** | — |

**Confirm 354 at step 2, do not assume it.** The count comes from the window brief and is
consistent with staging (which reads 345 with the stale rule applied), but prod's own
baseline capture is the authority. If step 2 shows a different starting count, the delta
must still be exactly the nine rows listed below — a different delta means something else
changed and the window stops.

#### ⚠️ Change 1 is user-visible and DELIBERATE

Oregon's Scores feed loses **nine games**: 354 → 345. They are the nine phantom fixtures
— scheduled, never scored, months past their date — that OHSLA never retires because the
source is additive-only. Marking them `stale` is a **fix**: they were never played, and
today the shipped app shows them as though they might still be.

But a shipped Oregon user's Scores list gets shorter, and that must not arrive as a
surprise. It is a third deliberate Oregon-visible change (after the context line and the
Playoffs tab) and belongs in the release notes — recorded in
`VarsityLaxApp/docs/user-visible-changes.md`.

The nine, all Oregon, all `scheduled` with no score:

```
2026-03-12  camas_wa v central_catholic      2026-04-10  lincoln v hood_river
2026-03-14  mt_view v burns                  2026-04-10  mountainside v forest_grove
2026-03-17  skyview_wa v hillsboro           2026-04-10  sunset v summit
2026-03-26  st_georges_ri v west_linn        2026-04-10  hillsboro v burns
                                             2026-04-10  newberg v westview
```

The 04-10 cluster is a cluster in the DATA, not in the process — all nine were created by
the same v1→v2 backfill, and 04-10 is simply a date OHSLA still lists fixtures for. See
`docs/data-quirks.md`.

### Sequence

Identical in shape to stage (b); only the payload differs.

```
 1. Fresh full mysqldump of prod, verified restorable        [rollback anchor]
 2. Capture prod baseline (scripts/capture-payloads.sh)      [before/]
 3. STOP varsitylax-cron                                     ← window opens
 4. Apply sections J (statements 2-5 ONLY — see emergency partial-J), K, L to prod
 5. Backfills, each --commit, each verified after:
      backfill-oregon-playoff-type.js   → 38 Oregon playoff games typed
      markStaleFixtures                 → 9 fixtures marked stale
      seed-playoff-formats.js           → 6 brackets, 6/6 anchors resolve
 6. git push  (auto-deploys varsitylax-api + varsitylax-cron)
      ⚠️ brief API blip, ~30-60s. Expected, not an incident.
 7. Confirm both services boot; check the [db] target=PROD line
 8. RESTART varsitylax-cron                                  ← window closes
 9. Capture prod again → diff against step 2; compare to the table above
10. ./scripts/prod-smoke.sh — 16/16 endpoints healthy. MANDATORY, immediately after
    step 6. This is the check whose absence caused the 2026-07-30 outage.
11. Watch one full cron cycle: scrape_log status=success, AND the 9 stale rows
    are NOT revived (the resurrection guard in dual-write.js)
```

Step 10's second clause is not optional. The first version of the stale marking would
have flipped all nine back to `scheduled` every two hours, because
`ON DUPLICATE KEY UPDATE status = VALUES(status)` overwrites the mark. The guard exists;
this is where it is proven on prod.

### Verification after step 5, before step 6

```
seed-playoff-formats.js  → OR 38/38 and WA 0/0 assigned, 0 orphans, 0 overlaps
                           (WA is empty on prod until stage (c) — expected)
SELECT COUNT(*) FROM playoff_formats WHERE season=2026        → 2 (Oregon only)
SELECT COUNT(*) FROM v_playoff_format_anchors WHERE season=2026 → 2, must equal above
SELECT COUNT(*) FROM games WHERE season=2026 AND status='stale' → 9
SELECT COUNT(*) FROM games WHERE season=2026 AND game_type='playoff' → 38
```

**Oregon seeds 2 brackets, not 6.** `scripts/seed-playoff-formats.js` declares all six;
the four Washington anchors will not resolve on prod because prod has no WA games. The
seeder STOPS on an unresolved anchor by design, so it must be run with the WA brackets
filtered out, or after stage (c). **Decide which before the window** — this is the one
step that differs materially from its staging rehearsal.

### Rollback

- **Before step 6:** sections J/K/L are additive DDL; drop `playoff_formats`,
  `stale_exemptions`, `v_stale_watch`, revert the status ENUM, drop `is_forfeit`. Data
  backfills reverse with `UPDATE ... SET status='scheduled'` / `game_type=NULL` on the
  affected id sets, which each script prints.
- **After step 6:** `git revert` the range and redeploy first, then roll the schema back.
  Old code cannot read the new columns but does not require them.
- **Anything unclear:** restore the step-1 dump. It is the anchor.

---

## Stage (c) — Washington data, decided separately

**The schema can ship long before Washington content does.** Stage (b) is a
pure-infrastructure release: prod gains columns and tables, Oregon output does
not move, and nothing user-visible changes.

Stage (c) is a separate decision with its own gates:

- WHSBLA **final** classification list (end of October) supersedes the 2027
  provisional wholesale — 2026 keeps `laxnumbers_provisional`, which the bracket
  tree validated
- WHSBLA **regions / conference groupings** still missing; league standings are
  blocked on them
- iOS work — state picker, division chips, empty states for rankings-only states
  — is not started
- Once WA data exists in prod, `schedule/all` and `schedule/playoffs` legitimately
  grow by the 6 policy-accepted cross-state rows

Shipping (b) without (c) is the low-risk path and is recommended.

---

## Pre-flight checklist

- [x] **2026-07-28** — Stage (a) rehearsal PASSED on `mysql:8.0.41` (see above)
- [ ] Fresh prod dump taken and verified restorable
- [ ] Prod baseline captured with `scripts/capture.sh`
- [ ] Cron stop/restart procedure confirmed in the Railway dashboard
- [x] **2026-07-28 (Spencer, Railway dashboard):** `STAGING_DATABASE_URL` is
      absent from both `varsitylax-cron` and `varsitylax-api`. The `db.js` guard
      would refuse a staging target whose host matches `DB_HOST`, but absent is
      cleaner than guarded.
- [ ] Someone is watching the first post-deploy cron cycle
- [x] **2026-07-28 (Spencer, by ruling)** — UptimeRobot: CLOSED. Free plan; threshold unverified and accepted. A page during step 6 is anticipated and ignorable. Proceed with the cron-pause plan as written.
- [ ] Window announced before it opens
- [x] **2026-07-28** — rehearsal instance verified at `SELECT VERSION()` = 8.0.41 before restore; service deleted after capture

## Deliberately NOT in this release

- Washington data in prod (stage c)
- Any iOS change — the app is unaffected; `?state=` defaults to `OR` everywhere
- Full punctuation-folding for `alias_normalized` (gated on proving no collision
  group spans two different teams)
- Same-day doubleheader / rematch `uq_game` gap — design-together item
- League/division standings view — blocked on WHSBLA groupings
- Per-state pre-warm coverage — a per-state **launch** gate, not an ingestion one
- `postgres-volume` cleanup — orphaned 134 MB volume from the mistaken Postgres
  service. `volumeDelete` returns `true` and does nothing (twice); schema
  introspection shows it is the only deletion mutation, so the stranded
  `volumeInstance f059f6b4-398f-4100-9122-14725283eb5d` is the likely blocker.
  Dashboard deletion by Spencer; Railway support ticket if it survives that.
  **Not a release blocker** — unattached, and it touches nothing this release
  uses.
- 2027 Sportability 10-day recent-scores polling

---

## Post-release, tied to the iOS build carrying the out-of-state tag

### `mountain_view_wa` display rename — SEQUENCED, not merely pending

```bash
node scripts/strip-state-suffix-mountain-view.js            # dry run against prod
node scripts/strip-state-suffix-mountain-view.js --commit    # apply
```

**Run only AFTER the App Store build carrying the out-of-state tag is LIVE** —
approved and released, not merely submitted.

This is sequencing, not caution. `mountain_view_wa` is named `"Mountain View (WA)"`
on prod today, and that suffix is the *only* thing distinguishing it from Oregon's
own `mt_view` ("Mountain View") on a prod user's screen. Prod has exactly one game
referencing it — Hillsboro, 2026-04-29 — which an Oregon user sees on Hillsboro's
schedule.

Rename before the tag ships and that row reads a bare "Mountain View", ambiguous
with the Oregon team of the same name, for however long review takes. The tag is
what takes over the disambiguating job; until it is on devices, the suffix is still
doing real work.

Ruled 2026-07-29: canonical display names are context-free; disambiguation is the
tag's job, derived per viewing context. Staging is already renamed, which is safe
because staging is only ever read by a Debug build carrying the tag.

**Prod needs one row staging did not.** Prod has no bare `"Mountain View"` alias for
the WA team, so after the rename its own display name would not resolve back to it.
The script detects and inserts it; it is idempotent and refuses if the current name
is anything other than `"Mountain View (WA)"`.

Verify after: both `"Mountain View"` and `"Mountain View (WA)"` resolve to
`mountain_view_wa` under `state='WA'`, and `"Mountain View"` still resolves to
`mt_view` under `state='OR'`. The script asserts all three and rolls back if any
fails.
