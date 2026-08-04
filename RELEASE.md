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

## Window #4-lite — AZ / ID / MT / NV game results

**Status: ✅ SHIPPED 2026-08-04. Applied to production, deploy live, 32/32 on the live
host. Every pin matched exactly.**

**These pins supersede everything measured before 2026-08-04 23:40.** Four earlier
rehearsals reported 32/32 while their smoke was answered by a stray API serving staging —
see "The gate that graded staging" below. The run behind the numbers above verified, on
its own output, that the API it questioned was the rehearsal container: `target=REHEARSAL`
in the API's own boot line, and API and container returning the same Oregon count.

Ships the 2026 season for the four rankings-only states, so 2.0's story becomes
"six states, full seasons" rather than "six states, four of them a ranked list".

### ⚠️ It is NOT purely data — one schema statement comes with it

`section-m-nullable-team-state.sql`: `teams.state` becomes nullable. Required, not
incidental — LaxNumbers publishes no state for an opponent string, and the alternatives
(a sentinel, an empty string, or 18 guesses) were each rejected on inspection; the
migration file records why. No existing row changes; the client already types `state` as
optional everywhere.

So the rollback is *four one-line capability flips plus a data delete*, and the schema
statement stays — it is harmless on its own and reverting it would break nothing that
the flips do not already cover.

### What ships

| # | step | script |
|---|---|---|
| 1 | `teams.state` nullable | `section-m-nullable-team-state.sql` |
| 2 | roster + games, four states | `import-laxnumbers-games.js --state=AZ,ID,MT,NV --stage-c --commit` |
| 3 | rankings backfill ×4 — **after** step 2 | `scrape-state-rankings.js {AZ,ID,MT,NV} --stage-c --commit` |
| 4 | **persistence assertion — STOPS THE WINDOW** | `assert-rankings-persisted.js --season=2026 --states=AZ,ID,MT,NV` |

**`--stage-c` is required on step 3 as well as step 2, and this runbook omitted it.** All
four states refused with `FATAL: resolved target is "prod"` on the first attempt. Nothing
was written and the guard did precisely its job — but the omission was invisible until the
window was open, because the rehearsal runs at `target=REHEARSAL` and never takes that
branch. Same shape as the prod-refusal guards that needed their own dry-run: **a guard the
rehearsal cannot reach is a guard the runbook must name.**
| 5 | `hasSchedules: false → true` ×4 | `src/config/states.js`, one line each |

**Step 4 is not optional and does not run "if there's time".** It is the same script the
rehearsal runs — a rehearsal that checks something the window does not proves nothing about
the window. If it exits non-zero, **stop**: do not flip the capability flags in step 5,
because a flag turned on over a missing snapshot is precisely a 404 in a user's app. Keep
its output together with step 3's `[write] server says:` lines; the pair is the evidence.

Step 2 imports the ROSTER as well as the games: our rosters were 6/5/2/6, created
incidentally as cross-border opponents, against 17/31/6/15 rated. Two thirds of the games
were unimportable for want of teams. For a rankings-only state LaxNumbers is the de facto
authority — the rankings already come from it — and the roster is explicitly PROVISIONAL,
superseded by a league export when SWILA/HSLL land. The importer header carries the
succession plan.

### Expected diff — RE-PINNED 2026-08-04 ON A FRESH PROD DUMP

Superseding the 2026-08-03 staging pin. These numbers come from `--window4` run against a
fresh production dump at prod's MySQL version and `sql_mode`, with the corrected
(state-scoped) import and the rankings backfill in place — not from staging, and not
computed.

| | before | after |
|---|---|---|
| AZ teams created / games in feed | 6 / — | **+11 / 123** |
| ID teams created / games in feed | 5 / — | **+27 / 219** |
| MT teams created / games in feed | 2 / — | **+5 / 50** |
| NV teams created / games in feed | 6 / — | **+10 / 135** |
| `laxnumbers`-sourced games | 0 | **476** |
| `laxnumbers` rankings snapshots | 0 | **4** — AZ 17, ID 31, MT 6, NV 15 |

476 = 118 AZ + 211 ID + 36 MT + 111 NV, and the count ladder closes at **UNEXPLAINED 0**
for every state.

**476, not the 475 pinned yesterday.** The extra row is Arizona's (117 → 118). The import
scrapes LaxNumbers live, so the source can gain a published result between two pins; the
ladder still closes at 0 and geographic coherence still flags nobody. It is recorded as
measured rather than reconciled to the older number.

### The gate that graded staging — RESOLVED, and it invalidated four runs

**2026-08-04.** A stray `node src/api.js`, started at 07:49 and left running, held port
3000 and served **staging**. `rehearse-on-prod-schema.sh` booted its own API, that process
lost the port, and every request in the smoke went to the stray one. Four consecutive runs
printed **"32/32 GATE PASSED — HEAD boots and serves against prod's schema"** while
measuring staging.

This is gate #5's whole purpose inverted. It exists because the P5 outage shipped behind a
wall of greens that had all run against staging; it then spent a day doing the same thing.
**Every green was true and irrelevant** — the second time, in the tool built to stop it.

It also manufactured the anomaly recorded below. There was never a lost write: run 1 served
404 for ID/MT/NV because *staging* had no snapshots for them yet, and the later runs passed
because the attempt to reproduce the "anomaly" had created them on staging in the meantime.
The reproduction attempt WAS the fix, which is why it never reproduced.

The tell was visible and I read past it: the API's `[db]` boot line was **absent** from the
rehearsal output for four runs. The script grepped for it and carried on when the grep
found nothing. **A boot line that is merely printed is not a check** — the same shape as a
smoke check that asserts a key exists.

What made it undeniable was asking the same question two ways: the container's own SQL said
Oregon had 383 games while the API answering the smoke said 347. Two sources, one question,
different answers.

Three structural defences now, none of which is "remember to check the port":

1. **A dedicated port, refused outright if occupied.** No silent fall-through to a stray.
2. **The booted API's own `[db]` line must say `REHEARSAL`, and its absence is fatal.**
3. **A truth anchor** — the API and the container are asked the same question and must
   return the same number, printed on every run. (1) and (2) prove we configured it right;
   only (3) proves the bytes on the wire came from the database we believe.

Retracted with it: **347 / 528 / 541 were staging's numbers**, and so was the entire
"HEAD filters 33 Oregon games" story built on them. Production serves 380 and 561 today,
which is exactly what Spencer's screenshots showed.

### The snapshot that reported success and was not there — CLOSED, see above

**2026-08-04.** With the ordering fix in place, a `--window4` rehearsal ran the rankings
backfill for all four states. Every state reported `resolves … unresolved: 0` and
`=== ALL CHECKS PASSED ===`, including the writer's own `PASS snapshot exists for state`.
Minutes later, in the same container, the API served **404 for ID, MT and NV**. Arizona,
written by the same loop moments earlier, was fine.

What has been ruled out, by inspection rather than by assumption:

- **Not a delete.** Nothing in `src/`, `scripts/` or `migrations/` deletes from
  `rankings_snapshots` or `ranking_entries`.
- **Not something running in between.** Only the coherence check (read-only) and the API
  boot sit between the loop and the smoke.
- **Not an uncommitted read.** The writer opens no transaction; the inserts autocommit.
- **Not the read path.** `latestSnapshot()` filters on `(source, season, state)` — it does
  not pick one snapshot per season and mis-scope it.
- **Not a pre-existing row masking Arizona.** Production holds `laxnumbers` snapshots for
  OR and WA only, so AZ's 200 came from the loop's own write.
- **Not reproducible.** Three consecutive delete-and-rewrite cycles of the identical loop
  on staging persisted all four every time; two subsequent rehearsals passed 32/32.

So: one red run, four greens, no mechanism. **It is intermittent and unexplained**, and
the next green run is not evidence it is gone.

The response is not a theory but a check. `scripts/assert-rankings-persisted.js` runs as a
**separate process on its own connection** after the writer, in the rehearsal AND as step 4
of the production window, and exits non-zero on any missing or empty snapshot. It lives
outside the writer deliberately: the failing run proved a check inside the writer can only
report that the writer believes itself.

**It also had to be made falsifiable before being trusted.** Run against a state with no
snapshot it exits 1 and names it; against the four real ones it exits 0. Wiring it into the
rehearsal introduced a fifth vacuous check on the way in — `node … | sed` reports *sed's*
exit status, so the `if !` guarding against vacuous checks could never itself fire. The
status is now captured directly.

**The instrumentation is the part that buys a future explanation.** Today "the write was
lost" and "the write landed somewhere else" are indistinguishable — both are a missing row,
and they call for opposite responses. Config can't separate them; config is what we
intended. So the writer and the assertion each log `@@hostname`, `DATABASE()`, `@@port` and
`CONNECTION_ID()` — the *server's* account of the connection it served. A recurrence now
leaves two comparable records rather than one ambiguous absence.

**Ledger entry: CLOSED — mechanism found, and it was not a lost write.** The snapshots
always persisted; the API being asked about them was a different server holding a different
database. The containment above is kept anyway: it is what turned an unfalsifiable absence
into a discriminating question, and it is what the instrumentation was asked to do.

### Rankings run AFTER the roster, and the ordering is load-bearing

`scrape-state-rankings.js` holds a **roster lock** — it creates no teams by design. Run
before the import, only the handful of teams that already existed as cross-border
opponents resolve, no snapshot is written at all, and the failure surfaces far downstream
as `/rankings?state=AZ` returning 404 after a window that reported success. The first
rehearsal of this window did exactly that.

#### ⚠️ OREGON AND WASHINGTON ARE NOT BYTE-STABLE — and the change is correct

The step-3 brief expected them to be. They are not, and the difference is real data
rather than churn:

| feed | before | after | added |
|---|---|---|---|
| Oregon `schedule/all` | 380 | **383** | +3 |
| Washington `schedule/all` | 561 | **563** | +2 |

Both feeds gain genuine cross-border games our curated sources never had — Bend/Caldera vs
Borah/Capital and so on. Nothing was removed.

**The `before` column is live production, checked directly.** Earlier revisions of this
table read 345 → 347 and 526 → 528. Those numbers came from STAGING, reached through a
stray API the rehearsal was unknowingly talking to (below). They were never Oregon's or
Washington's production feed and are retracted.

**Washington is +2, not the +15 this table claimed until 2026-08-04.** Thirteen of those
fifteen were the Mountain View collision: Idaho games written onto a Bellevue team because
a roster lookup searched globally while importing a single state. I reported them up as
"fifteen genuine cross-border games", and thirteen of them were corruption. The
state-scoped lookup now creates `mountain_view_id`, the thirteen games land on it, and
`check-geographic-coherence.js` holds it as a regression fixture at 13/13 same-state.
**A number in this table that gets smaller on re-measurement is not always churn.**

**Every pre-existing game is untouched**: comparing the 871 games present both before and
after BY NATURAL KEY rather than by array position gives **zero field differences**.
Rankings 41→41, teams 41/76 unchanged, playoffs 38/43 unchanged.

This makes Oregon's Scores feed the FOURTH deliberate Oregon-visible change, and it wants
a line in the release notes: two games appear that were always played and never listed.

#### Note on `payload-diff.js`, which reported this badly

It flagged **7747 CHANGED** — values flipping in both directions in near-equal counts
(`true→false ×114` alongside `false→true ×114`). That is positional drift: the tool
compares `games[]` index by index, so inserting rows into a date-sorted array shifts
everything after them. It is not wrong, but it cannot distinguish "inserted a row" from
"changed every row", and on this release it said the second when the first was true.
Verification had to fall back to a key-based comparison. Worth fixing before a release
where the distinction is less obvious.

### Sequence

```
 1. Fresh prod dump, verified restorable                   [rollback anchor]
 2. Capture prod baseline
 3. Apply section-m
 4. import-laxnumbers-games.js --state=AZ,ID,MT,NV --stage-c --commit
 5. Flip hasSchedules for the four states; git push (deploys)
 6. ./scripts/prod-smoke.sh — extended with minimum-count checks for all four
 7. Expected-diff assertions above, against live prod
 8. NO cron-cycle watch needed: these are one-off imports and the scraper registry is
    unchanged. The 2-hourly cycle keeps doing exactly what it did before.
```

### Rollback

Four independent one-line flips (`hasSchedules: true → false`), each hiding one state
without touching the others. Data: `DELETE FROM games WHERE canonical_source='laxnumbers'`
plus the roster rows the importer prints. Schema stays.

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
2. **`./scripts/rehearse-on-prod-schema.sh` — pre-push, mandatory at every phase exit.**
   The gate this postmortem really demands: HEAD's API booted against a **fresh prod
   dump** restored into `mysql:8.0.41` at prod's exact `sql_mode`, then smoke-tested.
   Not staging — prod's own schema. Fresh dump every run, because a cached one answers
   "did HEAD work against prod as it was whenever someone last looked", which is the
   question that produced this outage.

   Runs entirely locally via Docker (colima), no cloud resources and no cost.
   `--window2` additionally applies this window's migrations, so the runbook's written
   expected diff is *executed* rather than believed.

   **Proven able to fail.** Against the unmigrated prod schema it reports 2/18 endpoints
   failing (`v_playoff_format_anchors` missing) and refuses. Against the migrated schema
   it passes 18/18.

   That failure mode was itself found by running the gate: the FIRST version passed
   against a schema HEAD cannot serve, because `/api/v2/playoff-formats` — the only
   endpoint that hard-fails on a missing `playoff_formats` — was absent from the smoke
   list, and `/schedule/playoffs` degrades silently by design (`attachGraph` catches its
   own errors). A gate's coverage needs the same "prove it can fail" discipline as the
   code it guards.
3. **A static SQL/schema conformance checker was attempted and abandoned.** Parsing SQL
   out of `src/` and checking columns against `information_schema` reached 4 false
   positives against a healthy database after two rounds of tightening — it matched
   JavaScript property access and prose in comments. Recorded so nobody rebuilds it: a
   gate that cries wolf gets switched off, which is worse than no gate.

### The rule

**A phase exit may not push migration-coupled code until it has been run against prod's
schema, not staging's.** "Rehearse at prod's `sql_mode`" was the specific case; this is
the general one.

### The vacuous-pass family — a standing ledger

One shape keeps recurring, and it is not "the check was wrong". It is **a check that could
not have failed**, which reads on the console exactly like a check that passed. Each member
below was written in good faith, ran green, and certified nothing.

| # | the check | why it could not fail | the cure |
|---|---|---|---|
| 1 | five WA smoke checks | asserted a key existed; `{"games": []}` satisfies that. They passed against a database with **no Washington data at all** | specs gained a 4th field — a minimum element count |
| 2 | the LaxNumbers "control" | Oregon's control 403'd too, so it looked environmental. **Both arms used the same wrong client** (curl's headers, not axios's) — a control that shares the defect controls for nothing | vary only the variable under test |
| 3 | the `claude install` PATH probe | a pipeline whose `\|\|` branch could never execute, so "no existing reference" was structurally guaranteed. Verified with `zsh -lc`, which never reads `.zshrc` | check the exit status you actually depend on |
| 4 | `schedule/all?state=WA\|200\|season` | asserted a key called `season` existed and printed `2026`; **no number of games, including zero, could fail it** | real key, real floor: `\|200\|games\|500` |
| 5 | `node … \| sed` in the rehearsal | a pipeline reports the **last** command's status, so `if ! node … \| sed` tested *sed*. The guard against vacuous checks was itself one, on the way in | capture the status directly, before any pipe |

**Two more of the same shape, recorded here though they are not numbered members** — both
found 2026-08-04, both about evidence that was *printed* rather than *asserted*:

- The rehearsal grepped the API's `[db]` boot line and **carried on when the grep found
  nothing**. Its absence was the visible signature of the stray-API inversion for four
  runs. A boot line that is printed is not a check.
- `scrape-state-rankings.js`'s own `PASS snapshot exists for state` passed while the API
  served 404. A check inside the thing it checks can only report that the thing believes
  itself.

**The tell, in every case: ask what input would have made this red.** If no reachable input
would, it is not a check — it is a line of output. And the cure is never a better assertion
on the same evidence; it is a second, independent source for the same question. That is why
`assert-rankings-persisted.js` is a separate process, and why the rehearsal now asks the API
and the container the same thing and requires the same answer.

---

## Window #2 — playoff graph, stale fixtures, forfeits

**Status: ✅ CLOSED 2026-07-30. Executed on Spencer's explicit go. All 10 commits pushed and
deployed. Sections J(2-5)/K/L applied. Backfills committed. 18/18 endpoints healthy and
every written expected-diff assertion verified against live prod.**

### ⚠️ Executed in REORDERED form — push before migrate

The written sequence stops and restarts `varsitylax-cron` (steps 3 and 8). A standing
instruction forbids touching `varsitylax-cron` or `varsitylax-api` in any way, and
"run window #2" was not treated as lifting it. The window ran in an order that never
touches either service:

```
dump anchor → PUSH → smoke (expect 16/18) → J(2-5)/K/L → backfills → OR seed
            → smoke (expect 18/18) → cron-cycle watch → expected-diff vs live prod
```

**Why the ordering hazard disappears.** Stopping cron was necessary because the
stale-resurrection guard ships in the code push while the stale backfill lands earlier —
a cron cycle in that gap would flip all 9 rows back to `scheduled` via
`ON DUPLICATE KEY UPDATE status = VALUES(status)`. Pushing FIRST puts the guard live
before any stale row exists, so cron running throughout is a non-event rather than a
race.

**The cost, bounded and measured rather than argued.** Between the deploy and section L,
`/api/v2/playoff-formats` returns 500 and `/schedule/playoffs` silently drops its graph
fields (`attachGraph` catches its own errors by design). Nothing consumes either: the
shipped app predates both, and the iOS build that needs them is unreleased. That degraded
state is **exactly the baseline rehearsal run** — 16/18 with only the two
`playoff-formats` checks failing — so it was a known signature to assert against, not a
window to hope through.

**Checkpoint at every phase boundary.** Smoke asserted the expected state after the push
(16/18, precise failure signature) and after L (18/18). A degraded state you can name is
a checkpoint; one you assume is a hazard.

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

### ✅ Closing gate — confirmed over 38 cycles, not one

The watch armed on the night of the window died on a transient network error
(`EADDRNOTAVAIL`) before a cycle landed. Rather than re-arm for a single cycle, the gate
was confirmed three days later against everything that had accumulated — stronger
evidence than the original design asked for.

```
laxnumbers-v2/WA   success × 38   2026-07-31T00:04 → 2026-08-03T02:04
laxnumbers-v2/OR   success × 38   same window
laxpower-v2/OR     success × 38
ohsla-v2/OR        success × 36
non-success rows:  0
the nine:          3 8 17 31 71 140 257 288 360 — ALL still 'stale'
```

**WA rankings are CARRIED, not backfilled once.** That was the distinction the gate
existed for: 38 successful WA scrapes across three days means `enabled: true` took, and
the state will not silently freeze at whatever the one-off captured.

**The nine stale rows survived 36 further OHSLA cycles**, each re-asserting all 354
fixtures. The resurrection guard holds under sustained load, not just the first pass.

#### One number that needed explaining: 38 scrapes, 1 snapshot

`rankings_snapshots` holds a single WA row, from the backfill. That is correct and not a
silent write failure: snapshots are **content-addressed**, so a row is written only when
the rankings actually change. Oregon proves the same behaviour — its latest `laxnumbers`
snapshot is **2026-07-11**, three weeks stale, despite its own 38 successful scrapes in
this window. It is the offseason; the ratings are not moving.

Worth knowing before March 2027, when both states start producing a new snapshot most
cycles and this number stops being a flat line.

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

### ✅ Rehearsal result — 2026-07-30

`./scripts/rehearse-on-prod-schema.sh --window2`, against a dump taken that day.

```
mysql:8.0.41                     SELECT VERSION() → 8.0.41  (verified BEFORE restore)
sql_mode                         NO_ENGINE_SUBSTITUTION     (set, then verified)
prod dump                        516K, 18 tables, 1 view, DEFINER stripped, RESTORED
                                 → closes the "restorability not verified" gap
J statements 2-5                 ran clean; 0 rows affected — the no-op claim EXECUTED
K (status ENUM at non-strict)    applied clean — the spot the mode was expected to bite
L (playoff_formats + view)       applied clean
backfill-oregon-playoff-type     38 OR games typed; 0 non-completed rows typed
markStaleFixtures                9 marked
seed-playoff-formats --state=OR  2 brackets, OR 38/38 assigned, 0 orphans, 0 overlaps
HEAD API on that schema          booted, [db] target=REHEARSAL
prod-smoke.sh                    18/18 endpoints healthy
teardown                         container removed, dump deleted
```

**Every line of the written expected diff reproduced**, asserted by the script rather
than read off a log:

| assertion | result |
|---|---|
| Oregon `schedule/all` 354 → 345 | 345 ✓ |
| `/playoff-formats` is a new endpoint | 2 brackets ✓ |
| `schedule/playoffs` gains `bracketKey` | 38/38 ✓ |
| `schedule/playoffs` gains `round` | 38/38 ✓ |
| `schedule/playoffs` gains `advancesTo` | 36 (2 finals correctly null) ✓ |
| `isForfeit` present | 345/345 ✓ |
| `dateKey` present | 345/345 ✓ |
| `rankPosition` present | 41/41 ✓ |
| `playoffSource` becomes `game_type` | ✓ |
| both Oregon finals share one day | ✓ |

### ✅ Cron-cycle watch — the closing gate, 2026-07-30

The window stayed open until the resurrection guard was proven on PROD, not on staging.

```
cycle landed          2026-07-30 22:03:39Z  (schedule 0 */2 * * *, on time)
scrape_log            #3731 laxnumbers-v2/OR success 41
                      #3732 laxpower-v2/OR   success 41
                      #3733 ohsla-v2/OR      success 354
the nine stale rows   3 8 17 31 71 140 257 288 360 — ALL still 'stale'
```

**The number that matters is 354.** OHSLA's feed still lists every one of the nine
fixtures — the source is additive-only and never retires anything — so the scraper
re-asserted all 354 rows and the nine did NOT flip back to `scheduled`. That is the
`ON DUPLICATE KEY UPDATE` guard in `src/dual-write.js` working against live upstream
data, which is the only place it could ever have been proven.

Without the guard this window would have silently undone itself within two hours.

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

### ✅ Execution record — 2026-07-30

```
anchor dump          516K, 18 tables, terminator present, taken BEFORE anything
pre-state            354 games / 9 scheduled / 345 completed / 0 typed / 0 forfeits
push                 3607fa8..8521ae2, 10 commits, auto-deployed
deploy detected      playoff-formats 404 -> 500 (route now exists, table does not)
smoke #1             16/18 — ONLY the two playoff-formats checks failing ✓ rehearsed
J statements 2-5     0 / 0 / 0 / 0 rows — the no-op claim, executed on prod
K                    status ENUM now includes 'stale'; stale_exemptions + v_stale_watch
L                    playoff_formats + v_playoff_format_anchors
backfill game_type   38 in window, 0 already typed, 0 skipped, 38 typed, 0 non-completed
markStaleFixtures    9 marked — the nine documented rows, all OHSLA
seed --state=OR      2 brackets, OR 38/38 assigned, 0 orphans, 0 overlaps, 2/2 anchors
smoke #2             18/18 healthy
```

**Expected diff verified against LIVE PROD — all 14 assertions passed:**

| assertion | result |
|---|---|
| Oregon `schedule/all` 354 → 345 | 345 ✓ |
| `/playoff-formats` new endpoint | 2 brackets ✓ |
| `bracketKey` / `round` / `advancesTo` | 38 / 38 / 36 ✓ |
| `isForfeit`, `dateKey` on every game | 345 / 345 ✓ |
| `rankPosition` on every rankings row | 41 ✓ |
| `playoffSource` → `game_type` | ✓ |
| both Oregon finals share one day | ✓ |
| `declared == resolved` | ✓ |
| rankings 41, teams 41, v1 684 — unchanged | ✓ |

Prod's `date` confirmed as `2026-03-16T00:00:00.000Z` with `dateKey` `2026-03-16` —
the environment-dependent time component documented in `docs/api-contract.md` §1.3.

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

## Window #3 — stage (c): Washington goes live

**Status: ✅ CLOSED. Executed 2026-07-30, gate confirmed 2026-08-03 over 38 cron cycles.**

The release the 2.0 notes are written for. Until this runs, `/states` advertises
Washington as fully capable while serving 16 teams of 76, no rankings, no brackets and
**zero real Washington games** — a user who switches states sees Oregon's cross-border
fixtures presented as Washington's season.

### What ships

| # | step | script |
|---|---|---|
| 1 | roster, aliases, 2026 classifications, the 502-game season | `import-whsbla.js --commit` |
| 2 | 2027 classifications | `import-whsbla-2027.js --commit` |
| 3 | `game_type` adoption (exhibition / practice from the export) | `adopt-whsbla-game-types.js --commit` |
| 4 | WA rankings, one-off backfill | `scrape-state-rankings.js WA --commit` |
| 5 | WA playoff formats — **the stage-(c) seeder invocation, by name** | `seed-playoff-formats.js --state=WA --commit` |
| 6 | `enabled: true` for WA in the registry | code, ships with the push |

**Step 6 is smaller than it looks and worth stating exactly.** `enabled` gates the
SCRAPER, and its only consumer is `enabledStates('hasRankings')` in `cron.js` and
`index.js` — so it turns on **WA rankings scraping and nothing else**. Washington's games
are export-based and no code path tries to scrape them. Without it the backfill would be
a one-off and WA rankings would freeze at whatever step 4 captured, which is the
silently-stale failure this project keeps finding rather than a missing feature.

**Step 5 is the invocation the seeder's `--state` filter was built for.** The seeder
declares all six brackets and STOPS on an anchor that will not resolve; before this
window WA's four cannot resolve, because prod has no WA games.

### ✅ Rehearsal — 2026-07-30, `--window3`, gate PASSED

Fresh prod dump → `mysql:8.0.41` at prod's `NO_ENGINE_SUBSTITUTION` → full sequence →
HEAD's API booted against it → 24/24 endpoints healthy.

### Written expected diff — PINNED BY REHEARSAL, not computed

Every number below was produced by the rehearsal run and then asserted by a second run.
None of them is arithmetic.

| endpoint | before | after |
|---|---|---|
| `/teams?state=WA` (2026) | 16 | **76** |
| `/teams?state=WA` (2027) | 16 | **76** |
| `/schedule/all?state=WA` | 24 | **526** |
| `/schedule/playoffs?state=WA` | 0 | **43** |
| `/rankings/laxnumbers?state=WA` | **404** | **75** |
| `/playoff-formats?state=WA` | 0 declared / 0 resolved | **4 / 4** |
| `/schedule/team/mount_si_wa` | 1 | **23** |

**526, not 502.** The 502 is Washington-vs-Washington; the feed also carries the 24
cross-border games, which belong to both states by design.

#### ⚠️ OREGON DOES NOT MOVE — and that is the finding, not an assumption

| Oregon endpoint | before | after |
|---|---|---|
| `/schedule/all` | 345 | **345** |
| `/schedule/playoffs` | 38 | **38** |
| `/playoff-formats` | 2 / 2 | **2 / 2** |
| `/rankings/laxnumbers` | 41 | **41** |

The brief anticipated Oregon's feed changing by the policy-accepted cross-border rows.
**It does not change at all**, and the reason is that those 24 games were ALREADY in
Oregon's feed as OHSLA rows — the WHSBLA import matched them rather than duplicating
them, because the importer's ownership lookup and dedup key are orientation-independent.

That is the mirrored-duplicate fix from P5 paying off silently. Had it not been made,
this window would have added 24 duplicate Oregon games and nobody would have predicted
it from the plan. **Stage (c) is Oregon-invisible.**

### prod-smoke covers Washington now, and is proven failable

`scripts/prod-smoke.sh` gained six WA-parameterized checks — and, more importantly,
**minimum element counts**, because five of the six first passed against a database with
no Washington data in it. A check asserting only that a key EXISTS treats `{"games": []}`
as healthy. Against pre-import prod the suite now reports **6 of 24 failing**, naming the
empty ones; after the window it reports 24/24.

Until the window lands, run it as `SMOKE_SKIP=state=WA ./scripts/prod-smoke.sh`.

### Sequence

```
 1. Fresh full mysqldump of prod, verified restorable        [rollback anchor]
 2. Capture prod baseline (scripts/capture-payloads.sh)      [before/]
 3. Steps 1-5 above, each --commit, each verified after
 4. git push  (deploys the registry change; brief API blip, expected)
 5. ./scripts/prod-smoke.sh — 24/24, WA checks included, no SMOKE_SKIP
 6. Expected-diff table above, against live prod
 7. Watch one full cron cycle: scrape_log must now show a WA rankings row alongside
    Oregon's, and the nine stale rows must still be stale
```

Step 7's WA row is the proof that step 6 of "what ships" actually took — a rankings
backfill that the cron does not carry is indistinguishable from one it does, until the
data goes stale weeks later.

### Rollback

Data-only, and reversible by state: `DELETE` the WA rows added by steps 1-5 (each script
prints its id set), revert `enabled` to false, redeploy. The schema is untouched — window
#2 already carried every migration this window needs. **Anything unclear: restore the
step-1 dump.**

### Deliberately NOT in this window

**The `mountain_view_wa` display rename.** It stays sequenced to the App Store release
being LIVE, per its standing rule — approved and released, not merely submitted, so no
production user ever sees a bare "Mountain View" ambiguous with Oregon's. TestFlight
testers will see "(WA)" alongside the out-of-state tag for the intervening week; that is
cosmetic, known, and accepted rather than discovered.

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
