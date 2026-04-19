# Migration Runbook — Section E: API Migration

---

## E1. Confirm new-schema API endpoints exist and are unreachable from production

What to do: Before enabling dual-write or switching traffic, verify that the v2 API routes are deployed but not yet exposed — i.e., the router mounts them, but no production client has been pointed at them. This ensures the first dual-write writes succeed before any read traffic arrives.

> **Before running E1, record the production Railway domain here:**
> `Production domain: ___________________________`
>
> The current production domain is `bountiful-youth-production-5bf0.up.railway.app`. Confirm this is still correct in Railway before substituting it into the commands below.

```bash
# Confirm v2 routes are registered
curl -s -o /dev/null -w "%{http_code}" \
  https://bountiful-youth-production-5bf0.up.railway.app/api/v2/schedule/all
# Expected: 200 (route exists and returns data) or 401/403 if auth-gated
# NOT expected: 404 (route not mounted)

# Confirm v1 routes still respond normally
curl -s -o /dev/null -w "%{http_code}" \
  https://bountiful-youth-production-5bf0.up.railway.app/api/schedule/all
# Expected: 200
```

Expected output: v2 route returns 200 (or configured auth code). v1 route returns 200.

**GO:** Both routes respond. v1 is live. v2 is reachable but not yet in the iOS client's `Config.apiBaseURL`.
**NO-GO:** v2 returns 404 — the route is not deployed. Do not proceed until the v2 endpoint code is deployed.
If this fails: Deploy the v2 route handlers before continuing. Section E assumes code is deployed; it does not cover writing the route code itself.

---

## E2. Enable dual-write in the scraper

What to do: The scraper currently writes only to the legacy tables (`games_v1`, `rankings_v1`). Enable dual-write so each scraper run also writes to the new-schema tables (`games`, `game_source_records`, `rankings_snapshots`, `ranking_entries`). Both write paths must succeed for a scraper run to be considered successful.

> **Dual-write window purpose:** The iOS app continues reading from the v1 API during this window. The scraper writes to both schemas simultaneously, letting the new schema accumulate real data and be validated before client traffic is switched.

**Activate dual-write:**

```bash
# In Railway dashboard → varsitylax-scraper → Variables:
DUAL_WRITE_ENABLED=true
```

**Trigger a manual scraper run, then verify BOTH rankings AND schedule paths were written to both schemas:**

```sql
-- ── Rankings: new schema ──────────────────────────────────────────────────
SELECT source, season, captured_at
FROM   rankings_snapshots
ORDER  BY captured_at DESC
LIMIT  3;
-- Expected: a row with captured_at within the last few minutes

-- ── Rankings: legacy schema ───────────────────────────────────────────────
SELECT COUNT(*) AS v1_snapshots_today
FROM   rankings_v1
WHERE  snapshot_date >= CURDATE();
-- Expected: > 0

-- ── Schedule: new schema ─────────────────────────────────────────────────
SELECT COUNT(*) AS new_schedule_today
FROM   game_source_records
WHERE  scraped_at >= CURDATE()
  AND  source != 'backfill';
-- Expected: > 0 if any schedule data was scraped today
-- (0 is acceptable only very early in the pre-season before any results
-- are posted — confirm against OHSLA that no games occurred today)

-- ── Schedule: legacy schema ───────────────────────────────────────────────
-- Substitute the actual timestamp column name from the A3 legacy schema audit
SELECT COUNT(*) AS legacy_schedule_today
FROM   games_v1
WHERE  scraped_at >= CURDATE();
-- Expected: > 0 (same condition as above)
```

Expected output: all four queries return > 0 (or 0 with a confirmed no-games-today explanation for the schedule queries). Rankings and schedule must both show activity in both schemas from the same scraper run.

**GO:** All four queries pass. No scraper errors in Railway logs.
**NO-GO:** Either schema shows 0 rows on either the rankings or schedule path — dual-write is partially broken.
If this fails: Check Railway logs for the scraper run. A failed INSERT on the new-schema path should be logged with the offending query. Fix the query and re-trigger the scraper. Do not proceed until all four queries pass.

---

## E3. Monitor dual-write window (3 consecutive scraper runs over at least 48 hours)

What to do: Allow at least 3 scraper runs spanning at least 48 hours of elapsed time under dual-write before switching client traffic. Three hourly runs in a row are not sufficient — the goal is 3 different calendar days' worth of scraped data processed cleanly, verifying that the dual-write path is stable across date boundaries and varied game-day volumes. After each qualifying run, execute the three monitoring queries below. All three must pass on all three runs before proceeding to E4.

> **Minimum gate:** 3 clean runs AND ≥ 48 hours elapsed since E2 activation. Record start time here: `E2 activated at: ____________________`

**Run these after each scraper cycle:**

```sql
-- Monitor query 1: row counts growing in sync between schemas
SELECT
    (SELECT COUNT(*) FROM games   WHERE canonical_source IS NOT NULL) AS new_schema_sourced_games,
    (SELECT COUNT(*) FROM games_v1)                                   AS legacy_games;
-- new_schema_sourced_games should grow by approximately the same
-- delta as legacy_games after each run

-- Monitor query 2: no unresolved opponents in recent scraper output
SELECT DISTINCT g.id, home_t.slug AS home, away_t.slug AS away
FROM   game_source_records gsr
JOIN   games g      ON g.id = gsr.game_id
JOIN   teams home_t ON home_t.id = g.home_team_id
JOIN   teams away_t ON away_t.id = g.away_team_id
WHERE  gsr.scraped_at >= NOW() - INTERVAL 2 HOUR
  AND  gsr.source != 'backfill'
ORDER  BY gsr.scraped_at DESC
LIMIT  20;
-- Spot-check: every slug should be a real Oregon team or known
-- out-of-state placeholder. No raw unresolved strings.

-- Monitor query 3: canonical_source is set on all live-scraped games
SELECT COUNT(*) AS missing_canonical_source
FROM   games g
JOIN   game_source_records gsr ON gsr.game_id = g.id
WHERE  gsr.source   != 'backfill'
  AND  g.canonical_source IS NULL;
-- Expected: 0
```

**Run tracking log — complete one row per qualifying scraper cycle:**

| Run # | Timestamp | Elapsed since E2 | new_schema_sourced | legacy_games | missing_canonical | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

**GO:** All three monitoring queries pass on all three runs. At least 48 hours have elapsed since E2. Proceed to E4.
**NO-GO:** Any query shows a discrepancy, or the 48-hour minimum has not been reached.
If a query fails: Check Railway logs for the scraper run. Common causes: a new opponent string not in `team_aliases` (fix with D4 template), or a `canonical_source` value not in `game_source_priority` (add the row).

---

## E4. Add `Warning: 299` deprecation header to v1 endpoints

What to do: Before switching iOS client traffic to v2, signal that v1 is deprecated. The `Warning: 299` header notifies any non-iOS consumer (curl scripts, tests, future integrations). The `Sunset` header is intentionally omitted here — the deprecation clock must not start until E5 (client migration) is confirmed complete. The Sunset date is computed and applied in E5.5.

Add the following response header to every v1 route handler:

```javascript
// In each v1 route handler (Express example):
// Warning only — Sunset header is set in E5.5 after client migration completes
res.set('Warning', '299 - "This endpoint is deprecated. Migrate to /api/v2/. A Sunset date will be added after client migration is confirmed complete."');
```

**Verify the Warning header is present on live v1 responses:**

```bash
curl -sI https://bountiful-youth-production-5bf0.up.railway.app/api/schedule/all \
  | grep -i "warning"
# Expected:
# Warning: 299 - "This endpoint is deprecated..."
```

**Verify v2 routes do NOT carry this header:**

```bash
curl -sI https://bountiful-youth-production-5bf0.up.railway.app/api/v2/schedule/all \
  | grep -i "warning"
# Expected: no output (header absent on v2)
```

**GO:** Warning header present on v1. Header absent on v2.
**NO-GO:** Header missing on v1 or present on v2.
If this fails: Confirm the header-setting code is scoped to the v1 router middleware only, not applied globally.

---

## E5. Switch iOS client to v2 endpoints

> **⚠️ PREREQUISITE — FALLBACK IMPLEMENTATION REQUIRED BEFORE EXECUTING E5.**
>
> Phase 2 Part 5.4 specified Option C as the only safe rollback path: the iOS app must ship a network-layer fallback that silently retries any failed v2 request against the v1 endpoint. Without this, a v2 outage after cutover can only be remedied via App Store expedited review (Option B), which Phase 2 explicitly rejected as too slow.
>
> **Before executing E5:**
> 1. Confirm the v2→v1 fallback is implemented in the iOS networking layer.
> 2. Verify the fallback by pointing a test build at a deliberately broken v2 URL (e.g., `/api/v2-broken/`) and confirming the app silently retries v1 and displays correct data.
> 3. Record the test result here: `Fallback verified: YES / NO — ____________________`
>
> **If the fallback is not implemented: STOP. Do not cut over. Return to iOS development and implement the fallback before proceeding.**

What to do: Update `Config.apiBaseURL` (or equivalent v2 path prefix) in the iOS app so all DataService fetch calls target the new-schema API. This is the point of no return for read traffic.

```swift
// Config.swift (or equivalent)
// Before:
static let apiBaseURL = "https://bountiful-youth-production-5bf0.up.railway.app/api"

// After:
static let apiBaseURL = "https://bountiful-youth-production-5bf0.up.railway.app/api/v2"
```

**After deploying the iOS update, verify in production:**

```bash
curl -s https://bountiful-youth-production-5bf0.up.railway.app/api/v2/schedule/all \
  | python3 -m json.tool | head -30
# Expected: valid JSON with new-schema field names (rank_position not rank)

curl -s https://bountiful-youth-production-5bf0.up.railway.app/api/v2/rankings/laxnumbers?season=2026 \
  | python3 -m json.tool | head -20
# Expected: valid JSON with rank_position field
```

**Monitor v2 traffic for 15 minutes post-deploy:**

```bash
railway logs --service varsitylax-scraper --tail
# Watch for: no 500 errors on /api/v2/ routes
```

**Record E5 completion timestamp here (needed for E5.5 Sunset calculation):**
`E5 completed at: ____________________`

**GO:** v2 endpoints return valid JSON. No errors in logs for 15 minutes. iOS app shows correct schedules and rankings. Fallback test confirmed.
**NO-GO:** Any 500 errors or malformed JSON on v2 routes.
If this fails: The v2→v1 fallback (Phase 2 Part 5.4) should have already caught this transparently for users. Roll back `Config.apiBaseURL` in the iOS app and re-deploy. The v1 API remains live. Diagnose the v2 route error before re-attempting E5.

---

## E5.5. Add `Sunset` header to v1 endpoints

What to do: Now that E5 is complete and the iOS app is confirmed on v2, compute the Sunset date as E5 completion date + 90 days (Phase 2 Part 4.3 requires 60 days minimum, 90 days recommended, measured from iOS v2 app reaching the App Store — not from E4). Update the v1 route handlers to add the Sunset header alongside the Warning:299 set in E4.

**Compute Sunset date:**

```bash
# On macOS: substitute the actual E5 completion date
date -v +90d -j -f "%Y-%m-%d" "$(date +%Y-%m-%d)" "+%a, %d %b %Y 00:00:00 GMT"
# Example output if E5 completed 2026-04-25: "Fri, 24 Jul 2026 00:00:00 GMT"
```

Record the computed Sunset date here: `Sunset date: ____________________`

**Update the v1 route handler:**

```javascript
// Add Sunset header alongside the existing Warning header from E4
res.set('Sunset', '<computed date from above>');
res.set('Warning', '299 - "This endpoint is deprecated. Migrate to /api/v2/. Sunset: <computed date>."');
```

**Verify both headers are present on v1 responses:**

```bash
curl -sI https://bountiful-youth-production-5bf0.up.railway.app/api/schedule/all \
  | grep -i "sunset\|warning"
# Expected:
# Sunset: <computed date>
# Warning: 299 - "..."
```

**Verify v2 routes carry neither header:**

```bash
curl -sI https://bountiful-youth-production-5bf0.up.railway.app/api/v2/schedule/all \
  | grep -i "sunset\|warning"
# Expected: no output
```

**GO:** Both headers on v1. Neither header on v2. Sunset date is ≥ 90 days after E5 completion.
**NO-GO:** Sunset date is less than 90 days from E5, or headers appear on v2.
If this fails: Recompute the Sunset date from the E5 completion timestamp, not from today's date.

---

## E6. Disable v1 write path in the scraper

What to do: Once the iOS client is confirmed stable on v2 for at least 24 hours with no errors, stop the scraper from writing to the legacy `*_v1` tables. The scraper now writes exclusively to the new-schema tables.

> **After E6, v1 API endpoints continue responding but serve data frozen at the E6 timestamp.** The `*_v1` tables are no longer being updated. Any client still pinned to the v1 API — older iOS builds, curl scripts, third-party integrations — is now receiving stale schedule and rankings data without any server-side indication beyond the deprecation headers set in E4/E5.5.
>
> Monitor v1 traffic in Railway logs continuously after E6. Any sustained v1 traffic indicates clients serving stale data to users. **Do not proceed to Section F until v1 traffic has dropped below the threshold specified in Phase 2 Part 4.3: < 1% of v2 request volume, sustained for 7+ consecutive days.** Record that threshold crossing date in the E7 sign-off log.

```bash
# In Railway dashboard → varsitylax-scraper → Variables:
DUAL_WRITE_ENABLED=false
```

**Trigger a manual scraper run and confirm only new-schema tables were written:**

```sql
-- New schema received the run
SELECT source, season, captured_at
FROM   rankings_snapshots
ORDER  BY captured_at DESC
LIMIT  3;
-- Expected: a fresh row within the last few minutes

-- Legacy rankings table did NOT receive the run
SELECT MAX(snapshot_date) AS last_v1_rankings_write FROM rankings_v1;
-- Expected: a timestamp from BEFORE this scraper run

-- Legacy schedule table did NOT receive the run
-- (substitute actual timestamp column from A3 legacy schema audit)
SELECT MAX(scraped_at) AS last_v1_schedule_write FROM games_v1;
-- Expected: a timestamp from BEFORE this scraper run
```

Record E6 completion timestamp here (needed for E7 timing gate):
`E6 completed at: ____________________`

**GO:** New-schema tables updated. Both legacy tables frozen. No new rows in `rankings_v1` or `games_v1` after the scraper run.
**NO-GO:** Legacy tables still receiving writes.
If this fails: Confirm the environment variable change was saved in Railway and the scraper service redeployed after the change.

---

## E7. Section E sign-off gate

> **E7 must be run at least 24 hours after E6 completes.** The frozen-data check (Check 4 below) uses a 24-hour lookback window — running E7 immediately after E6 will cause that check to fail. Record E6 completion time from E6 above and do not begin E7 until 24 hours have elapsed.

```sql
-- Check 1: New schema is the sole write target
SELECT COUNT(*) AS live_source_records_today
FROM   game_source_records
WHERE  scraped_at >= CURDATE()
  AND  source != 'backfill';
-- Expected: > 0 (scraper is actively writing to new schema)

-- Check 2: No unresolved aliases in recent scraper output
SELECT COUNT(*) AS missing_canonical_today
FROM   games g
JOIN   game_source_records gsr ON gsr.game_id = g.id
WHERE  gsr.scraped_at >= CURDATE()
  AND  gsr.source     != 'backfill'
  AND  g.canonical_source IS NULL;
-- Expected: 0

-- Check 3: v2 endpoints returning data (manual curl — see E5 verification commands)

-- Check 4: Legacy tables frozen — no new rows in the past 24 hours
SELECT
    (SELECT MAX(snapshot_date) FROM rankings_v1) AS last_v1_rankings_write,
    (SELECT MAX(scraped_at)    FROM games_v1)    AS last_v1_schedule_write,
    NOW()                                        AS now;
-- Both timestamps should be > 24 hours ago

-- Check 5: v1 traffic below Phase 2 Part 4.3 threshold
-- (inspect Railway request logs — v1 route hits vs v2 route hits)
-- Required: v1 traffic < 1% of v2 traffic for 7+ consecutive days
-- Record the date this threshold was first met: ____________________
```

Sign-off criteria:

| # | Item | Status |
|---|---|---|
| 1 | E1: v2 routes deployed and reachable before dual-write | ☐ |
| 2 | E2: Dual-write activated; rankings AND schedule confirmed in both schemas | ☐ |
| 3 | E3: 3 clean runs spanning ≥ 48 hours documented in tracking table | ☐ |
| 4 | E4: Warning:299 header live on all v1 routes; absent on v2 | ☐ |
| 5 | E5: iOS fallback (Phase 2 Part 5.4) verified before cutover | ☐ |
| 6 | E5: iOS client on v2; stable ≥ 15 min post-deploy | ☐ |
| 7 | E5.5: Sunset header set to E5 date + 90 days; verified on v1 only | ☐ |
| 8 | E6: v1 write path disabled; both legacy tables frozen | ☐ |
| 9 | Check 1: live_source_records_today > 0 | ☐ |
| 10 | Check 2: missing_canonical_today = 0 | ☐ |
| 11 | Check 4: both v1 timestamps > 24 hours ago | ☐ |
| 12 | Check 5: v1 traffic < 1% of v2 for 7+ consecutive days | ☐ |

```
DATE (≥ 24h after E6):    ____________________
EXECUTOR:                  ____________________
E5 completed at:           ____________________
Sunset date (E5 + 90d):   ____________________
E6 completed at:           ____________________
v1 < 1% threshold date:   ____________________
v2 deploy SHA:             ____________________
iOS deploy build:          ____________________
Section E:                 ✅ APPROVED
```

---

*End of Section E. Section F covers legacy table cleanup: dropping `*_v1` tables after the Sunset date, removing the dual-write code path, and archiving the pre-migration schema.*
