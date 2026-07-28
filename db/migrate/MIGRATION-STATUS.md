# Phase 3 Migration Status

Last updated: 2026-07-24 17:25 PDT — **Section E ✅ APPROVED (E7 signed off; Check 5 closed early at 5/7 clean days by Spencer)**

## Incident 2026-07-19 — custom domain down, cert stuck "Issuing TLS certificate" (RESOLVED)

RESOLVED 2026-07-19: removed + re-added the domain on varsitylax-api. Railway issued a
**new CNAME target** (`3czytx5k.up.railway.app`, was `uy4d6yu2`) and required the
`_railway-verify.api` TXT (already present from Jul 11 setup, token unchanged). Updated
the CNAME at DreamHost → domain validated, cert issued, and
https://api.varsitylaxapp.com/api/v2/health returns ok (lastGameWrite 2026-07-19 15:05).
Lesson: a Railway domain re-add rotates the CNAME target — always check DNS records shown
in the domain dialog. Original details below.

`api.varsitylaxapp.com` (v2 primary host) is unreachable — Railway service settings show
the domain stuck on "Issuing TLS certificate". DNS verified clean via dns.google:
CNAME api → uy4d6yu2.up.railway.app → Railway edge 69.46.46.97; no CAA records; DreamHost
SOA serial 2026071101 (zone untouched since Jul 11 setup) → problem is on Railway's side.
Worked as recently as Jul 16 17:54 PDT (E7 Check 3 evidence). Service itself is Online and
serving fine on bountiful-youth-production-5bf0.up.railway.app.

Impact: v1.6.0 clients can't reach v2 → **v1 fallback engaged in production and worked**
(Spencer's weekend usage appears in HTTP logs as v1 GETs incl. /api/schedule/playoffs and
team paths; zero v2 hits since Jul 16). Fallback serves frozen-at-Jul-15 v1 data — benign
in offseason (data static). Sunset headers unaffected.

Consequences: (a) weekend traffic is NOT evidence about v1.6.0 v2-adoption — it's
fallback traffic; (b) E7 Check 5 clock cannot start until the domain is fixed; (c) real-
world proof the E5 Option C fallback works.

Fix path: remove + re-add the custom domain in Railway → varsitylax-api → Settings →
Networking to re-trigger issuance (domain already down, nothing to lose), or Railway
support if it sticks again. Verify with https://api.varsitylaxapp.com/api/v2/health.

## Incident 2026-07-12/13 — dual-write silently reverted to legacy (RESOLVED)

Monitor flagged E2 NO-GO on 2026-07-13: no v2 writes since Jul 11. Root cause:
`WRITE_MODE` was **absent** from the varsitylax-cron service variables on Railway
(only DB_* + SEASON present) — the Jul 11 GitHub redeploy ran without it, so every
cron run since defaulted to legacy-only. The E2 dual runs verified Jul 10–11
evidently didn't persist the variable to the cron service's environment.

Fix (2026-07-13 ~08:00 PDT): added `WRITE_MODE=dual` to varsitylax-cron via Raw
Editor, deployed, triggered manual run. Note: the first Run now (07:54) still ran
legacy — it landed on the old deployment before the variable redeploy activated.
Second run (08:03) confirmed in logs: `Starting scrape run (WRITE_MODE=dual)`,
LaxNumbers/LaxPower v2 snapshots hash-deduped (unchanged), and
`[OHSLA] ✓ v2: 354 matchups upserted, 0 stale pruned` at 08:06.

Lesson for E4/E5.5/E6: after any Railway variable change, verify the redeploy is
ACTIVE before triggering a run, and check the startup WRITE_MODE log line.

## Complete

- **Section A** — pre-flight audit, all 13 gates GO. Backup: `db/migrate/backups/` (local only, gitignored). A7 classification: `a7-classification.json`.
- **Section B** — 12 tables + view created alongside legacy (no rename needed — no name collisions; v1 API untouched throughout).
- **Section C** — 41 venues, 72 teams (41 OR + 31 OOS), 193 aliases, 41 team_seasons, coaches. C5 gate adapted (slug+name resolution, not row count); collation handled per-query.
- **Section D** — 363 games backfilled (now 354 after prune, see below), W-L for all 41 teams (parity: OOS 23-20, delta 3), both ranking sources. Runbook bugs fixed: missing `season` in D1 INSERT; literal-string dedup broken for co-op names.
- **E1** — v2 API live and verified (`/api/v2/health`, rankings, teams, schedule/all|playoffs|team/:slug).
- **E2** — `WRITE_MODE=dual` active on Railway; both schemas confirmed written; monitor CLEAN.
- **Reschedule-orphan fix** — dual-write now prunes stale scheduled/scoreless rows missing from the current feed (scoped to successfully-scraped teams, 20% circuit breaker). 9 stale backfill rows pruned; v2 sourced == total == 354.

## In progress — clock gates

- **E3** — ✅ CLOSED 2026-07-13: clean runs 2026-07-10 (×2) + 2026-07-13 (all four
  checks GO after dual-write fix), spanning >48h. Log: `out/section-e-tracking.md`.
- **E4** — ✅ DONE 2026-07-13: `V1_DEPRECATION_WARNING=true` set on varsitylax-api
  via Raw Editor, deployed, service Online.

## Remaining

| Step | Action | Gate |
|---|---|---|
| E5 | ✅ DONE — **v1.6.0 live on App Store, confirmed 2026-07-13** (submitted 2026-07-11, auto-release). Fallback verified 2026-07-10 (simulator vs /api/v2-broken/: all tabs correct, v1 fallback succeeded on every fetch) | complete |
| E5.5 | ✅ DONE 2026-07-13 — `V1_SUNSET_DATE="Sun, 11 Oct 2026 00:00:00 GMT"` (2026-07-13 + 90d) set on varsitylax-api | complete |
| E6 | ✅ DONE 2026-07-14 ~17:50 PDT — `WRITE_MODE=v2` set on varsitylax-cron (Raw Editor), redeploy verified ACTIVE before triggering. Manual run 17:55 PDT: startup log `Starting scrape run (WRITE_MODE=v2)`; v2-only writes confirmed — LaxNumbers/LaxPower snapshots hash-deduped, `[OHSLA] ✓ v2: 354 matchups upserted, 0 stale pruned`, zero legacy write lines. /api/v2/health lastGameWrite matches run. (Note: health serializes timestamps as `Z` but values look like PDT — cosmetic, worth a look before E7.) | complete |
| E7 | ✅ APPROVED 2026-07-24 — Checks 1–4 re-verified GO via Railway console on varsitylax-api (DB NOW 2026-07-24 17:23 UTC): Check 1 live_source_records_today=354; Check 2 missing_canonical=0; Check 3 v2 rankings (41 teams) + schedule/all (354 games, datetime populated) over custom domain; Check 4 legacy frozen — laxnumbers_rankings 2026-07-15 00:04:00 UTC, team_schedules 2026-07-15 00:04:39 UTC (~9.7d). **Check 5 (amended gate) closed early at 5/7 clean days by Spencer's decision** — 5 consecutive clean days Jul 20–24, flat-zero v1 traffic; 2 remaining observation days waived. Sign-off block filled in `runbook-section-e.md`. | ✅ signed off |
| F | Drop legacy tables (`team_schedules`, `laxnumbers_rankings`, etc.) after Sunset date | **waits for 2026-10-11 sunset** |

## E7 Check 5 findings (2026-07-16, Railway HTTP logs, deployment since Jul 13 08:42 PDT)

v1 traffic is currently **far above** 1% of v2 — the 7-day clock has not started:

1. **Uptime monitor on v1**: `HEAD /api/rankings/laxnumbers` every ~5 min around the clock
   (~288 req/day, matches UptimeRobot's default HEAD+5min pattern). This alone swamps the
   ratio. → ACTION (Spencer): repoint the monitor to `/api/v2/health` (or a v2 route). The
   gate can't start until this is moved or explicitly excluded from the count.
2. **Old-client GETs on v1**: bursts of `GET /api/rankings/laxnumbers` + `/api/schedule/all`
   (mix of 200/304), roughly 10–30/day on Jul 15–16 — classic pre-1.6.0 app-launch fetch
   pattern. Expected decay as users update; sunset headers are doing their job.
3. **Zero v2 client traffic since Jul 13**: no hits at all on `/api/v2/rankings/*`,
   `/api/v2/schedule/all`, or `/api/v2/teams` (only daily `/api/v2/health` checks). Could be
   off-season quiet, but combined with (2) it's worth verifying in App Store Connect that
   v1.6.0 is actually released/propagating before trusting the traffic ratio.

Once the monitor is repointed and the first day of v1 <1% of v2 is observed, record that
date as the Check 5 threshold date; sign-off is 7 consecutive clean days later.

UPDATE 2026-07-19: after the domain fix, v2 client traffic confirmed — multiple
`GET /api/v2/rankings/laxnumbers` (200/304) at 16:22 PDT from Spencer's phones. v1.6.0 →
v2 path verified end-to-end in production.

**Check 5 gate AMENDED (approved by Spencer 2026-07-19):** the literal "v1 <1% of v2 for
7 days" is unattainable off-season (old-client v1 GETs ~10-30/day vs light v2 volume;
would need >1-3k v2 req/day). Amended gate: **zero monitor/synthetic traffic on v1 routes
AND old-client v1 GETs declining (or flat-low) for 7 consecutive days.** Rationale: v1
stragglers are auto-updating installs served by deprecation+sunset headers until the
Oct 11 sunset; they cannot be forced off v2-side.

**Clock started 2026-07-19 ~16:45 PDT:** UptimeRobot monitor (the only monitor, account
support@varsitylaxapp.com) repointed from
`bountiful-youth-…railway.app/api/rankings/laxnumbers` (HEAD, 5min) to
`https://api.varsitylaxapp.com/api/v2/health` and renamed "VarsityLax v2 health". Bonus:
it now watches the custom domain, so a repeat of today's cert incident alerts within 5min.
First full clean day = Jul 20 → E7 sign-off eligible **2026-07-26** if daily checks stay
clean.

### Check 5 daily log (amended gate)

| Date | v1 monitor HEADs | v1 old-client GETs | v2 traffic | Clean? |
|---|---|---|---|---|
| Jul 19 (day 0) | last at 16:31:56 PDT (pre-repoint); v2/health HEADs flowing after | ~15-25 (incl. pre-fix fallback bursts) | health ok; client GETs 16:22 | baseline |
| Jul 19 eve (verified 17:07 PDT, automated check) | 0 since repoint — last v1 HEAD 16:31:56; v2/health HEADs every ~5min 16:27→17:07 ✓ | ~14 today (bursts 12:41/13:56/15:50, all pre-repoint; none after) | health ok, lastGameWrite 17:03; monitor HEADs + client GETs on v2 | ✓ repoint verified |
| Jul 20 (day 1, verified ~17:10 PDT, automated check) | 0 — last v1 HEAD still Jul 19 16:31:56; v2/health HEADs every ~5min through 17:07 ✓ | **0** — last v1 rankings GET Jul 19 15:50:04; /api/schedule/all also 0 today | health ok, lastGameWrite Jul 20 17:02 (26h ✓, custom domain/TLS ✓); v2 client GETs 10:49 (/api/v2/rankings/laxnumbers ×4) | ✅ Day 1 of 7 clean |
| Jul 21 (day 2, verified ~17:10 PDT, automated check) | 0 — last v1 HEAD still Jul 19 16:31:56; v2/health HEADs every ~5min through 17:06 ✓ | **0** — last v1 rankings GET still Jul 19 15:50:04; /api/schedule/all still Jul 19 15:50:03 | health ok, lastGameWrite Jul 21 17:02 (26h ✓, custom domain/TLS ✓); v2 client GETs 08:36 (×5, 304) + 15:13 (200) | ✅ Day 2 of 7 clean |
| Jul 22 (day 3, verified ~11:10 PDT manual + re-verified 17:10 PDT automated full-day check) | 0 — last v1 HEAD still Jul 19 16:31:56; v2/health HEADs every ~5min through 17:04 ✓ | **0** — last v1 rankings GET still Jul 19 15:50:04; /api/schedule/all still Jul 19 15:50:03 | health ok, lastGameWrite Jul 22 17:02 (fresh ✓, custom domain/TLS ✓); v2 client GETs Jul 22 08:23 + burst 17:05 (rankings/laxnumbers, schedule/all, schedule/team/oes, schedule/playoffs) | ✅ Day 3 of 7 clean (full day verified) |
| Jul 23 (day 4, verified ~17:10 PDT, automated check) | 0 — last v1 HEAD still Jul 19 16:31:56; v2/health HEADs every ~5min through 17:09 ✓ | **0** — last v1 rankings GET still Jul 19 15:50:04; /api/schedule/all still Jul 19 15:50:03 | health ok, lastGameWrite Jul 23 17:04 (26h ✓, custom domain/TLS ✓); v2 client GETs last Jul 22 17:05 burst (none yet today — off-season quiet, gate unaffected) | ✅ Day 4 of 7 clean |
| Jul 24 (day 5, verified ~17:15 PDT, automated check) | 0 — last v1 HEAD still Jul 19 16:31:56 (HEAD filter list ends there, nothing newer) ✓ | **0** — last v1 rankings GET still Jul 19 15:50:04; /api/schedule/all still Jul 19 15:50:03 (both filter lists reach "start of range" and end Jul 19) | health ok, lastGameWrite Jul 24 17:03:07 (fresh ✓, custom domain/TLS ✓); v2 client GETs today Jul 24 14:52:19 (200) + 14:52:26 (304) on /api/v2/rankings/laxnumbers | ✅ Day 5 of 7 clean |

**GATE CLOSED EARLY 2026-07-24 (Spencer's decision):** after 5 consecutive clean days
(Jul 20–24) with flat-zero v1 traffic and healthy v2, Spencer elected to close the amended
Check 5 gate rather than wait the remaining 2 days (Jul 25–26). Rationale: operational cutover
already completed at E6 (2026-07-14); v1 trend is flat-zero and can't be forced lower from the
v2 side; remaining stragglers are served by deprecation + Sunset headers until 2026-10-11.
E7 Checks 1–4 re-verified clean the same day and Section E signed off. **The
`varsitylax-migration-daily-check` scheduled task is no longer needed and can be deleted.**

## Session E env knobs (already deployed, all default-off)

`WRITE_MODE` (legacy|dual|v2) · `V1_DEPRECATION_WARNING` (true) · `V1_SUNSET_DATE` (HTTP date) · `PLAYOFFS_START` (YYYY-MM-DD)

## iOS v2 adoption — CODE COMPLETE (2026-07-10, needs build + test on Mac)

Written in VarsityLaxApp (version bumped to 1.4.0 build 1):
- `Sources/Services/APIClient.swift` (new) — generic v2→v1 fallback (E5 Option C)
- `Sources/Services/DataService.swift` — all 5 fetch paths try v2 first, decode
  v1 shape on fallback; MockData remains the third tier. v2 gives neutral rows,
  so client-side dedup is gone on schedule/all.
- `Sources/Config/Config.swift` — apiV2Base/apiV1Base, custom-domain TODO,
  `forceBrokenV2ForFallbackTest` flag for the E5 fallback verification build.
- Backend: dual-write now parses "4:30pm" → games.game_datetime (next scrape
  populates all 354 games; without this, v2 cutover would drop game times).

Spencer's checklist before E5:
1. `cd VarsityLaxApp && xcodegen` (picks up APIClient.swift), build in Xcode.
2. Push scraper repo (game_datetime change) and confirm a dual run shows times
   in /api/v2/schedule/all (`datetime` non-null for games that had times).
3. Fallback test: set `forceBrokenV2ForFallbackTest = true`, run in simulator,
   verify all tabs show data + console shows "v1 fallback succeeded". Set back
   to false. Record result in runbook E5 prerequisite line.
4. Custom domain — ✅ LIVE 2026-07-11: https://api.varsitylaxapp.com serving
   v2 over valid TLS (CNAME api -> uy4d6yu2.up.railway.app at DreamHost;
   the empty api.varsitylaxapp.com hosted-site shell was set to No Web
   Hosting to clear conflicting auto A records). Config.swift: v2 primary on
   custom domain, v1 fallback deliberately kept on the Railway URL as an
   independent host (covers domain DNS/cert failure too).
5. ✅ DONE 2026-07-11: TestFlight upload successful as version 1.6.0;
   submitted to App Store review. **App Store release = E5 executes.**
   On release day: record the E5 timestamp here, set V1_SUNSET_DATE on
   Railway to release + 90 days (E5.5), then after 24h stable flip
   WRITE_MODE=v2 (E6). E4 (V1_DEPRECATION_WARNING=true) can flip as soon
   as E3's third clean run lands (~2026-07-12).

## Strategic notes for the iOS session

- Point the new build at a custom domain (`api.varsitylaxapp.com`) instead of the
  raw Railway URL — one-time chance while shipping an update anyway.
- v2 response shapes differ from v1 deliberately: neutral game rows with
  `home`/`away` objects, `rank_position`, `slug` identifiers, numbers as numbers.
  See `src/api-v2.js`.
- See `docs/data-quirks.md` before touching scrapers.
