# Release plan — Phase F multi-state schema

**Status: DRAFT for review. No push has occurred. No prod migration has occurred.**

Twelve-plus commits sit unpushed on `main`. This is one **coupled** release: the
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

**Not verified by me — check before the window opens:** UptimeRobot's alert
threshold for that monitor. If it is set to alert on a *single* failed check,
a routine deploy will page. If it requires 2+ consecutive failures, a ~30-60s
restart between 5-minute pings will almost certainly pass unnoticed. I have no
access to that dashboard, so this is a pre-flight item for Spencer, not a
confirmed fact.

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

- [ ] Stage (a) rehearsal passed on `mysql:8.0`
- [ ] Fresh prod dump taken and verified restorable
- [ ] Prod baseline captured with `scripts/capture.sh`
- [ ] Cron stop/restart procedure confirmed in the Railway dashboard
- [x] **2026-07-28 (Spencer, Railway dashboard):** `STAGING_DATABASE_URL` is
      absent from both `varsitylax-cron` and `varsitylax-api`. The `db.js` guard
      would refuse a staging target whose host matches `DB_HOST`, but absent is
      cleaner than guarded.
- [ ] Someone is watching the first post-deploy cron cycle
- [ ] UptimeRobot alert threshold checked (see "Monitoring during the window")
- [ ] Window announced before it opens
- [ ] Rehearsal instance verified at `SELECT VERSION()` = 8.0.41 before restore

## Deliberately NOT in this release

- Washington data in prod (stage c)
- Any iOS change — the app is unaffected; `?state=` defaults to `OR` everywhere
- Full punctuation-folding for `alias_normalized` (gated on proving no collision
  group spans two different teams)
- Same-day doubleheader / rematch `uq_game` gap — design-together item
- League/division standings view — blocked on WHSBLA groupings
- Per-state pre-warm coverage — a per-state **launch** gate, not an ingestion one
- 2027 Sportability 10-day recent-scores polling
