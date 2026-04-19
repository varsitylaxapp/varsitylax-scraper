# Migration Runbook — Section D: Data Backfill

---

## D1. Backfill `games` from `games_v1`

What to do: Insert one neutral matchup row per unique game. Each Oregon-vs-Oregon game appears twice in `games_v1` (once per team's `is_home` perspective); keep only the `is_home = 1` row. Oregon-vs-out-of-state games appear only once; keep them regardless of `is_home` value. Resolve both sides via `team_aliases.alias_normalized`. Set `canonical_source = NULL` — the FK to `game_source_priority` would reject the string `'backfill'`, which belongs only in `game_source_records.source`.

> **⚠️ NOT IDEMPOTENT.** There is no `INSERT IGNORE` guard here — `games` has no natural UNIQUE KEY that would silently absorb duplicates. If this INSERT fails mid-run, `TRUNCATE TABLE games;` (and `TRUNCATE TABLE game_source_records;`) before restarting. Do not re-run against a partially populated `games` table.

```sql
INSERT INTO games (
    home_team_id,
    away_team_id,
    game_date,
    game_datetime,
    venue_id,
    is_conference,
    is_overtime,
    is_scrimmage,
    home_score,
    away_score,
    status,
    canonical_source,
    created_at
)
SELECT
    -- Home/away team IDs: flip based on is_home flag
    CASE WHEN g.is_home = 1 THEN our_t.id   ELSE opp_t.id   END AS home_team_id,
    CASE WHEN g.is_home = 1 THEN opp_t.id   ELSE our_t.id   END AS away_team_id,

    DATE(g.game_date)                                            AS game_date,

    -- game_datetime intentionally NULL: legacy games.time is a
    -- VARCHAR ("4:30pm"), requires non-trivial parsing. Deferred.
    NULL                                                         AS game_datetime,

    -- Venue: home team's registered field; NULL for out-of-state home teams
    CASE WHEN g.is_home = 1 THEN our_t.home_venue_id
                             ELSE opp_t.home_venue_id END        AS venue_id,

    g.is_conference,
    g.is_overtime,
    g.is_scrimmage,

    CASE WHEN g.is_home = 1 THEN g.team_score ELSE g.opp_score  END AS home_score,
    CASE WHEN g.is_home = 1 THEN g.opp_score  ELSE g.team_score END AS away_score,

    -- Both scores must be non-NULL to call the game completed.
    -- OR would mark a game 'completed' with one NULL score, causing
    -- v_team_season_record to silently exclude it from W-L counts.
    CASE WHEN g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
         THEN 'completed' ELSE 'scheduled' END                   AS status,

    NULL                                                         AS canonical_source,
    NOW()                                                        AS created_at

FROM games_v1 g

-- Resolve the perspective team (games_v1.team_id is always an Oregon slug)
JOIN team_aliases our_ta
     ON our_ta.alias_normalized = LOWER(TRIM(g.team_id))
JOIN teams our_t
     ON our_t.id = our_ta.team_id

-- Resolve the opponent (raw display name or slug from the scraper)
JOIN team_aliases opp_ta
     ON opp_ta.alias_normalized = LOWER(TRIM(g.opponent))
JOIN teams opp_t
     ON opp_t.id = opp_ta.team_id

-- Dedup:
--   Keep is_home=1 rows always (authoritative home-team perspective).
--   Keep is_home=0 rows only when no is_home=1 counterpart exists —
--   this covers Oregon teams playing away against out-of-state opponents.
WHERE g.is_home = 1
   OR NOT EXISTS (
        SELECT 1 FROM games_v1 g2
        WHERE  g2.is_home = 1
          AND  LOWER(TRIM(g2.team_id))  = LOWER(TRIM(g.opponent))
          AND  LOWER(TRIM(g2.opponent)) = LOWER(TRIM(g.team_id))
          AND  DATE(g2.game_date)       = DATE(g.game_date)
   );
```

```sql
-- Quick row count immediately after INSERT
SELECT COUNT(*) AS games_inserted FROM games;
```

Expected output: a positive integer. The exact expected value is computed in D2.

**GO:** INSERT completed without error. Row count > 0.
**NO-GO:** INSERT throws an error.
If a FK error fires on `canonical_source`: confirm `canonical_source = NULL` is in the SELECT list — a non-null value there would require a matching row in `game_source_priority`.
If a FK error fires on `home_team_id` or `away_team_id`: an alias resolved to a `teams.id` that no longer exists — check `team_aliases` for orphaned `team_id` values.

---

## D2. Verify dedup count against expected distinct matchup count

What to do: Compare the number of rows inserted in D1 against the number of logically distinct matchups in `games_v1`. The two counts should be equal. Any gap must be fully explained before proceeding.

```sql
-- Rows in the new table
SELECT COUNT(*) AS games_inserted
FROM games;

-- Distinct canonical matchups in the legacy table.
-- LEAST/GREATEST sorts the team pair so OR-vs-OR games
-- (which appear twice, once per perspective) collapse to one key.
SELECT COUNT(DISTINCT
    CONCAT(
        LEAST( LOWER(TRIM(team_id)), LOWER(TRIM(opponent)) ),
        '|',
        GREATEST( LOWER(TRIM(team_id)), LOWER(TRIM(opponent)) ),
        '|',
        DATE(game_date)
    )
) AS distinct_matchups_in_source
FROM games_v1;
```

Expected output: `games_inserted = distinct_matchups_in_source`.

**GO:** Counts are equal. Proceed to D5.
**NO-GO:** `games_inserted` < `distinct_matchups_in_source`.
Any gap must be fully explained — do not proceed until each dropped row is accounted for. First, check for scraper duplicates in the source (same team + opponent + date entered more than once):

```sql
SELECT team_id, opponent, DATE(game_date), COUNT(*) AS dupes
FROM games_v1
GROUP BY team_id, opponent, DATE(game_date)
HAVING COUNT(*) > 1;
```

Confirmed scraper duplicates reduce `distinct_matchups_in_source` by their excess count and are not a defect — document the count. Any remaining gap not explained by scraper duplicates indicates unresolved aliases; proceed to D3.

---

## D3. Investigate dropped games via unresolved alias check

What to do: If D2 shows a gap, identify which raw strings in `games_v1` failed to match a `team_aliases` row and therefore caused their rows to be silently dropped by D1's inner JOINs.

```sql
-- Opponents that failed to resolve (opp_ta JOIN miss)
SELECT
    g.opponent                    AS unresolved_opponent,
    COUNT(*)                      AS dropped_rows,
    MIN(DATE(g.game_date))        AS earliest,
    MAX(DATE(g.game_date))        AS latest
FROM   games_v1 g
LEFT JOIN team_aliases opp_ta
       ON opp_ta.alias_normalized = LOWER(TRIM(g.opponent))
WHERE  opp_ta.id IS NULL
GROUP  BY g.opponent
ORDER  BY dropped_rows DESC;

-- team_id values that failed to resolve (our_ta JOIN miss)
-- Should be 0 rows if C5 completed correctly; non-zero indicates
-- a slug in games_v1.team_id that was not seeded in team_aliases.
SELECT
    g.team_id                     AS unresolved_team_id,
    COUNT(*)                      AS dropped_rows
FROM   games_v1 g
LEFT JOIN team_aliases our_ta
       ON our_ta.alias_normalized = LOWER(TRIM(g.team_id))
WHERE  our_ta.id IS NULL
GROUP  BY g.team_id
ORDER  BY dropped_rows DESC;
```

Expected output: both queries return **0 rows** (gap is already explained by D2 scraper-duplicate check).

**GO:** 0 rows in both queries. The D2 gap is fully explained. Proceed to D5.
**NO-GO:** Any unresolved strings returned.
Proceed to D4 for each unresolved string before continuing.

---

## D4. Fix missing aliases and re-insert affected rows

What to do: For each unresolved string found in D3, add the missing alias (and a placeholder `teams` row if needed), then re-insert only the games that were previously dropped. Repeat D3 after each cycle until it returns 0 rows.

**Step 4a — Add the missing team and alias (repeat per unresolved string):**

```sql
-- Only needed if the opponent has no teams row yet
INSERT IGNORE INTO teams (slug, name, city, state)
VALUES ('<slug>', '<Display Name>', '<city>', '<state_code>');

INSERT IGNORE INTO team_aliases (team_id, alias, source)
SELECT id, '<raw string exactly as it appears in games_v1.opponent>', 'backfill'
FROM   teams
WHERE  slug = '<slug>';
```

**Step 4b — Re-insert only the dropped games (scoped to the affected opponent):**

```sql
-- Same INSERT as D1, filtered to only the newly resolved opponent.
-- This adds only the rows that were previously dropped — no risk of
-- duplicating already-inserted games because the opponent string
-- was unresolvable during D1 and therefore produced no rows then.
INSERT INTO games (
    home_team_id, away_team_id, game_date, game_datetime,
    venue_id, is_conference, is_overtime, is_scrimmage,
    home_score, away_score, status, canonical_source, created_at
)
SELECT
    CASE WHEN g.is_home = 1 THEN our_t.id  ELSE opp_t.id  END,
    CASE WHEN g.is_home = 1 THEN opp_t.id  ELSE our_t.id  END,
    DATE(g.game_date),
    -- game_datetime intentionally NULL: legacy games.time is a
    -- VARCHAR ("4:30pm"), requires non-trivial parsing. Deferred.
    NULL,
    CASE WHEN g.is_home = 1 THEN our_t.home_venue_id
                             ELSE opp_t.home_venue_id END,
    g.is_conference, g.is_overtime, g.is_scrimmage,
    CASE WHEN g.is_home = 1 THEN g.team_score ELSE g.opp_score  END,
    CASE WHEN g.is_home = 1 THEN g.opp_score  ELSE g.team_score END,
    CASE WHEN g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
         THEN 'completed' ELSE 'scheduled' END,
    NULL, NOW()
FROM   games_v1 g
JOIN   team_aliases our_ta ON our_ta.alias_normalized = LOWER(TRIM(g.team_id))
JOIN   teams our_t          ON our_t.id = our_ta.team_id
JOIN   team_aliases opp_ta  ON opp_ta.alias_normalized = LOWER(TRIM(g.opponent))
JOIN   teams opp_t          ON opp_t.id = opp_ta.team_id
WHERE  LOWER(TRIM(g.opponent)) = LOWER(TRIM('<newly resolved raw string>'))
  AND  (g.is_home = 1 OR NOT EXISTS (
            SELECT 1 FROM games_v1 g2
            WHERE  g2.is_home = 1
              AND  LOWER(TRIM(g2.team_id))  = LOWER(TRIM(g.opponent))
              AND  LOWER(TRIM(g2.opponent)) = LOWER(TRIM(g.team_id))
              AND  DATE(g2.game_date)       = DATE(g.game_date)
       ));
```

**Step 4c — Re-run D3 after each alias addition.** Repeat D4 until D3 returns 0 rows, then re-run D2 to confirm counts now match.

---

## D5. Backfill `game_source_records`

What to do: Insert one `game_source_records` row per game migrated in D1, recording the legacy scraper as the source. `source = 'backfill'` is valid here — `game_source_records.source` has no FK constraint. `canonical_source = NULL` on the `games` row (set in D1) correctly signals that no live scraper source owns these games.

```sql
INSERT INTO game_source_records (
    game_id,
    source,
    home_team_raw,
    away_team_raw,
    home_score,
    away_score,
    scraped_at
)
SELECT
    g.id                AS game_id,
    'backfill'          AS source,
    home_t.slug         AS home_team_raw,
    away_t.slug         AS away_team_raw,
    g.home_score        AS home_score,
    g.away_score        AS away_score,
    NOW()               AS scraped_at
FROM   games g
JOIN   teams home_t ON home_t.id = g.home_team_id
JOIN   teams away_t ON away_t.id = g.away_team_id
WHERE  g.canonical_source IS NULL;
```

```sql
-- Verify: one game_source_records row per backfilled game
SELECT
    (SELECT COUNT(*) FROM games               WHERE canonical_source IS NULL) AS backfilled_games,
    (SELECT COUNT(*) FROM game_source_records WHERE source = 'backfill')      AS gsr_rows;
-- Expected: both values equal
```

Expected output: `backfilled_games = gsr_rows`.

**GO:** Counts match.
**NO-GO:** `gsr_rows` < `backfilled_games` — some games have no source record.
If this fails: Run `SELECT g.id FROM games g LEFT JOIN game_source_records gsr ON gsr.game_id = g.id WHERE g.canonical_source IS NULL AND gsr.id IS NULL;` to find the orphaned game IDs, then re-run the INSERT scoped to those IDs.

---

## D6. Refresh `team_seasons` W-L cache

What to do: Recompute wins and losses for every Oregon team's 2026 season row using `v_team_season_record`. Using LEFT JOIN with COALESCE ensures that teams with no completed games still receive `wins = 0`, `losses = 0`, and a non-NULL `wl_computed_at` — preventing D8 Check 6 from flagging them as failures.

```sql
UPDATE team_seasons ts
LEFT JOIN v_team_season_record v
       ON  v.team_id = ts.team_id
       AND v.season  = ts.season
SET    ts.wins           = COALESCE(v.wins, 0),
       ts.losses         = COALESCE(v.losses, 0),
       ts.wl_computed_at = NOW()
WHERE  ts.season = 2026;
```

```sql
-- Verify: wl_computed_at must be non-NULL for every Oregon team
SELECT COUNT(*) AS not_yet_computed
FROM   team_seasons ts
JOIN   teams t ON t.id = ts.team_id
WHERE  ts.season = 2026
  AND  t.state   = 'OR'
  AND  ts.wl_computed_at IS NULL;
-- Expected: 0

-- Teams with 0-0 record after backfill (genuinely played no completed games)
SELECT t.slug, ts.wins, ts.losses
FROM   team_seasons ts
JOIN   teams t ON t.id = ts.team_id
WHERE  ts.season = 2026
  AND  t.state   = 'OR'
  AND  ts.wins   = 0
  AND  ts.losses = 0
ORDER  BY t.slug;
-- Document any 0-0 teams; verify against OHSLA that they genuinely
-- had no completed games rather than an alias resolution failure.
```

```sql
-- W-L parity check
SELECT
    SUM(ts.wins)   AS total_wins,
    SUM(ts.losses) AS total_losses,
    SUM(ts.wins) - SUM(ts.losses) AS oos_delta
FROM   team_seasons ts
WHERE  ts.season = 2026;
-- Expected: oos_delta >= 0; equals Oregon wins against out-of-state opponents
```

> **W-L parity note:** `delta = 0` holds only if every opponent of every Oregon team also has a `team_seasons` row. Out-of-state teams (seeded in C3 with no `team_seasons` row) accumulate losses in the `games` table that no Oregon `team_seasons` row absorbs. `delta` will therefore equal the total number of Oregon wins against out-of-state opponents — a positive integer, not a defect. Record the delta value in the D8 sign-off log.

```sql
-- Spot-check top 10 teams by games played
SELECT t.slug, ts.wins, ts.losses, ts.wl_computed_at
FROM   team_seasons ts
JOIN   teams t ON t.id = ts.team_id
WHERE  ts.season = 2026
  AND  t.state   = 'OR'
ORDER  BY (ts.wins + ts.losses) DESC
LIMIT  10;
```

Cross-check the top 5 W-L totals against laxnumbers.com or OHSLA. Totals should be plausible (Oregon varsity programs typically play 10–20 games per season).

**GO:** UPDATE affected 41 rows. `not_yet_computed = 0`. Any 0-0 teams confirmed against OHSLA. Spot-check W-L totals match external source within ±1.
**NO-GO:** `not_yet_computed > 0` after the UPDATE, or a team with known completed games shows 0-0.
If this fails: Confirm `v_team_season_record` returns rows for the affected team (`SELECT * FROM v_team_season_record WHERE team_id = <id> AND season = 2026;`). If the view returns 0 rows, check that the team's games have `status = 'completed'` — a game with one NULL score is stored as `'scheduled'` and excluded from the view's W-L aggregation.

---

## D7. Backfill `rankings_snapshots` and `ranking_entries` (conditional)

What to do: If `rankings_v1` was preserved during the B1 rename, backfill historical ranking data. If the table does not exist or is empty, skip this step entirely and proceed to D8.

**Step 7a — Check whether source data exists:**

```sql
-- Check table existence
SELECT COUNT(*) AS rankings_v1_exists
FROM   information_schema.tables
WHERE  table_schema = DATABASE()
  AND  table_name   = 'rankings_v1';
```

If `rankings_v1_exists = 0`: **skip D7 entirely. Proceed to D8.**

```sql
-- Check row count (only if table exists)
SELECT COUNT(*) AS source_rows FROM rankings_v1;
```

If `source_rows = 0`: **skip D7 entirely. Proceed to D8.**

---

**Step 7b — Insert one `rankings_snapshots` row per distinct scrape event:**

> This assumes `rankings_v1` has at least: `source` (VARCHAR), `season` (INT), `snapshot_date` (DATE or DATETIME), and `team_name` (VARCHAR). Adjust column names to match the actual `rankings_v1` structure.

```sql
INSERT IGNORE INTO rankings_snapshots (
    source,
    season,
    captured_at,
    content_hash
)
SELECT DISTINCT
    r.source,
    r.season,
    r.snapshot_date                   AS captured_at,
    MD5(CONCAT_WS('|',
        r.source,
        r.season,
        DATE(r.snapshot_date)
    ))                                AS content_hash
FROM   rankings_v1 r;
```

```sql
-- Verify snapshot rows
SELECT source, season, COUNT(*) AS snapshots
FROM   rankings_snapshots
GROUP  BY source, season
ORDER  BY season, source;
```

Expected output: one or more rows corresponding to distinct source+season scrape events in `rankings_v1`.

---

**Step 7c — Insert `ranking_entries` rows:**

```sql
INSERT INTO ranking_entries (
    snapshot_id,
    team_id,
    rank_position,
    rating,
    agd,
    sched,
    record_wins,
    record_losses
)
SELECT
    rs.id              AS snapshot_id,
    ta.team_id,
    r.rank_position,
    r.rating,
    r.agd,
    r.sched,
    r.record_wins,
    r.record_losses
FROM   rankings_v1 r

-- Match back to the rankings_snapshots row we just created
JOIN   rankings_snapshots rs
       ON  rs.source           = r.source
       AND rs.season           = r.season
       AND DATE(rs.captured_at) = DATE(r.snapshot_date)

-- Resolve team name → team_id via alias table
JOIN   team_aliases ta
       ON  ta.alias_normalized = LOWER(TRIM(r.team_name));
```

```sql
-- Verify: entry count matches source rows
SELECT
    (SELECT COUNT(*) FROM rankings_v1)     AS source_rows,
    (SELECT COUNT(*) FROM ranking_entries) AS entry_rows;
-- Expected: equal, or entry_rows slightly lower if some team_name values
-- were unresolvable via team_aliases (log those separately below)

-- Unresolvable team names in rankings_v1
SELECT DISTINCT r.team_name AS unresolved, COUNT(*) AS occurrences
FROM   rankings_v1 r
LEFT JOIN team_aliases ta
       ON ta.alias_normalized = LOWER(TRIM(r.team_name))
WHERE  ta.id IS NULL
GROUP  BY r.team_name
ORDER  BY occurrences DESC;
-- Expected: 0 rows
```

**GO:** Entry counts match. 0 unresolvable team names.
**NO-GO:** `entry_rows` < `source_rows` and unresolved team names are found.
If this fails: Add the missing aliases using the C3/D4 template, then re-run only the INSERT for the affected team names (add `AND LOWER(TRIM(r.team_name)) = LOWER(TRIM('<name>'))` to the WHERE clause).

> **Note on `rank_position`:** The column is named `rank_position` in Phase 1 — not `rank`. If `rankings_v1` has a column named `rank`, reference it as `r.rank` in the SELECT but write it into `rank_position` in the INSERT column list. Do not use `rank` as a column alias — it is a reserved word in MySQL 8.0.

---

## D8. Section D sign-off gate

Run all checks. Every check must pass before Section E (API migration) begins.

```sql
-- Check 1: Game count parity
SELECT
    (SELECT COUNT(*) FROM games) AS new_games,
    (SELECT COUNT(DISTINCT
        CONCAT(
            LEAST( LOWER(TRIM(team_id)), LOWER(TRIM(opponent)) ),
            '|',
            GREATEST( LOWER(TRIM(team_id)), LOWER(TRIM(opponent)) ),
            '|',
            DATE(game_date)
        )
     ) FROM games_v1)            AS source_matchups;
-- new_games should equal source_matchups ± documented scraper-duplicate count

-- Check 2: No orphaned game_source_records
SELECT COUNT(*) AS orphaned_gsr
FROM   game_source_records gsr
LEFT JOIN games g ON g.id = gsr.game_id
WHERE  g.id IS NULL;
-- Expected: 0

-- Check 3: Every backfilled game has exactly one source record
SELECT COUNT(*) AS games_missing_gsr
FROM   games g
LEFT JOIN game_source_records gsr
       ON gsr.game_id = g.id
WHERE  g.canonical_source IS NULL
  AND  gsr.id IS NULL;
-- Expected: 0

-- Check 4: W-L parity delta (document value, not a hard failure)
SELECT
    SUM(wins)          AS total_wins,
    SUM(losses)        AS total_losses,
    SUM(wins) - SUM(losses) AS oos_delta
FROM   team_seasons
WHERE  season = 2026;
-- Expected: oos_delta >= 0 and equals documented out-of-state win count

-- Check 5: No null team IDs in games
SELECT COUNT(*) AS null_team_id_games
FROM   games
WHERE  home_team_id IS NULL OR away_team_id IS NULL;
-- Expected: 0

-- Check 6: team_seasons wl_computed_at is populated for all OR teams
SELECT COUNT(*) AS not_yet_computed
FROM   team_seasons ts
JOIN   teams t ON t.id = ts.team_id
WHERE  ts.season = 2026
  AND  t.state   = 'OR'
  AND  ts.wl_computed_at IS NULL;
-- Expected: 0
```

Sign-off criteria:

| Check | Requirement | Status |
|---|---|---|
| 1 | `new_games = source_matchups` ± documented scraper dupes | ☐ |
| 2 | 0 orphaned game_source_records | ☐ |
| 3 | 0 backfilled games missing a source record | ☐ |
| 4 | `oos_delta` ≥ 0; value documented below | ☐ |
| 5 | 0 games with NULL home or away team | ☐ |
| 6 | 0 team_seasons rows with NULL `wl_computed_at` | ☐ |
| 7 | Rankings backfilled (or skipped with reason documented) | ☐ |

```
DATE:              ____________________
EXECUTOR:          ____________________
games rows:        ____________________
gsr rows:          ____________________
Scraper dupes:     ____________________
OOS delta:         ____________________
Rankings skipped:  YES / NO
Section D:         ✅ APPROVED
```

---

*End of Section D. Section E covers API migration: dual-write instrumentation, v1/v2 endpoint versioning, and the Sunset header rollout.*
