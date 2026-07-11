# Phase 3 Migration Status

Last updated: 2026-07-10 (end of session)

## Complete

- **Section A** — pre-flight audit, all 13 gates GO. Backup: `db/migrate/backups/` (local only, gitignored). A7 classification: `a7-classification.json`.
- **Section B** — 12 tables + view created alongside legacy (no rename needed — no name collisions; v1 API untouched throughout).
- **Section C** — 41 venues, 72 teams (41 OR + 31 OOS), 193 aliases, 41 team_seasons, coaches. C5 gate adapted (slug+name resolution, not row count); collation handled per-query.
- **Section D** — 363 games backfilled (now 354 after prune, see below), W-L for all 41 teams (parity: OOS 23-20, delta 3), both ranking sources. Runbook bugs fixed: missing `season` in D1 INSERT; literal-string dedup broken for co-op names.
- **E1** — v2 API live and verified (`/api/v2/health`, rankings, teams, schedule/all|playoffs|team/:slug).
- **E2** — `WRITE_MODE=dual` active on Railway; both schemas confirmed written; monitor CLEAN.
- **Reschedule-orphan fix** — dual-write now prunes stale scheduled/scoreless rows missing from the current feed (scoped to successfully-scraped teams, 20% circuit breaker). 9 stale backfill rows pruned; v2 sourced == total == 354.

## In progress — clock gates

- **E3**: 3 clean daily monitor runs spanning ≥48h. Day 1 = 2026-07-10 (2 clean runs).
  Run `node db/migrate/section-e-monitor.js` after each daily scrape; log auto-appends
  to `out/section-e-tracking.md`.

## Remaining

| Step | Action | Gate |
|---|---|---|
| E4 | Railway: `V1_DEPRECATION_WARNING=true` | after E3 (≥2026-07-12) |
| E5 | iOS: v2 DataService + **v2→v1 fallback (hard prereq)**, new `Config.apiBaseURL`; App Store release | fallback verified on broken-URL test build |
| E5.5 | Railway: `V1_SUNSET_DATE` = E5 date + 90 days | after E5 confirmed |
| E6 | Railway: `WRITE_MODE=v2` | ≥24h stable after E5 |
| E7 | Sign-off checks | ≥24h after E6; v1 traffic <1% of v2 for 7 days |
| F | Drop `*_v1`… actually legacy tables (`team_schedules` etc.) after Sunset date | ~Oct 2026 |

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
4. DECISION — custom domain: configure api.varsitylaxapp.com in Railway +
   DNS CNAME, then change `Config.apiHost` before shipping. Strongly
   recommended: this is the last cheap chance to unpin from the Railway URL.
5. TestFlight → App Store review → release = E5 executes.

## Strategic notes for the iOS session

- Point the new build at a custom domain (`api.varsitylaxapp.com`) instead of the
  raw Railway URL — one-time chance while shipping an update anyway.
- v2 response shapes differ from v1 deliberately: neutral game rows with
  `home`/`away` objects, `rank_position`, `slug` identifiers, numbers as numbers.
  See `src/api-v2.js`.
- See `docs/data-quirks.md` before touching scrapers.
