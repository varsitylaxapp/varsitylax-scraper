# VarsityLax Phase 3 Migration Runbook — Section A: Pre-flight

*All steps in Section A are read-only against production. The one exception is A2's disposable test table, which runs inside the `varsitylax_restore_test` schema on your local workstation — not against production. Complete all steps and record all outputs before proceeding to Section B.*

---

**A1. Confirm production database backup exists and is restorable**

What to do: Take a fresh manual dump of the production database and verify it restores cleanly before touching anything.

Command / Query:
```bash
# Step 1: dump production
mysqldump \
  --host=$DB_HOST \
  --port=$DB_PORT \
  --user=$DB_USER \
  --password \
  --single-transaction \
  --routines \
  --triggers \
  --databases varsitylax \
  > /tmp/varsitylax_preflight_$(date +%Y%m%d_%H%M%S).sql

# Step 2: confirm dump is non-trivial
wc -l /tmp/varsitylax_preflight_*.sql
du -sh  /tmp/varsitylax_preflight_*.sql
```

```bash
# Step 3: restore and spot-check.
#
# DreamHost quota note: if DreamHost storage is tight for restoring a
# full copy, restore to a LOCAL MySQL instance on your workstation instead.
# This tests that the dump is SQL-valid, not application-valid — after
# restore, spot-check that a few rows look correct (dates, scores, opponent
# names), not just that COUNT(*) is non-zero.

mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS varsitylax_restore_test;"
mysql -u root -p varsitylax_restore_test \
  < /tmp/varsitylax_preflight_*.sql

# Row count spot-check
mysql -u root -p varsitylax_restore_test -e "
  SELECT 'games',    COUNT(*) FROM games
  UNION ALL SELECT 'rankings', COUNT(*) FROM rankings
  UNION ALL SELECT 'teams',    COUNT(*) FROM teams;
"

# Data spot-check (substitute actual column names from A3 if needed)
mysql -u root -p varsitylax_restore_test -e "
  SELECT team_id, date, opponent, team_score, opp_score
  FROM games ORDER BY date DESC LIMIT 5;
"

# Step 4: clean up
mysql -u root -p -e "DROP DATABASE varsitylax_restore_test;"
```

Expected output: Dump file > 50 KB. Line count > 500. Row counts non-zero and match production. Spot-checked rows show recognizable team names, plausible dates, and numeric scores.

**GO:** Dump exists, non-trivial size, restore succeeds, spot-checked rows look correct.
**NO-GO:** Dump fails, file is empty or < 1 KB, restore produces zero rows, or spot-checked data looks corrupt.
If this fails: Do not proceed. Diagnose the dump error (credentials, network, quota, permissions). Fix before any DDL runs.

---

**A2. Run MySQL capability checks**

What to do: Confirm the production MySQL version and InnoDB configuration support ROW_FORMAT=DYNAMIC and generated stored columns; the one write in this step (a disposable test table) runs inside the restore schema on your local workstation — all queries against production are read-only.

Command / Query:
```sql
-- Run against production (read-only):

SELECT VERSION() AS mysql_version;

SHOW VARIABLES LIKE 'innodb_default_row_format';

-- innodb_large_prefix: removed in MySQL 8.0. See GO/NO-GO below for all branches.
SHOW VARIABLES LIKE 'innodb_large_prefix';

-- innodb_file_format: also removed in MySQL 8.0. Empty = correct on 8.0+.
SHOW VARIABLES LIKE 'innodb_file_format';

SHOW CHARACTER SET LIKE 'utf8mb4';

SELECT
  CASE
    WHEN VERSION() >= '8.0' THEN 'MySQL 8.0+ confirmed'
    WHEN VERSION() >= '5.7' THEN 'MySQL 5.7 — verify generated column support manually'
    ELSE 'UNSUPPORTED — stop'
  END AS version_status;
```

```sql
-- Run against varsitylax_restore_test on local workstation (write allowed):
CREATE TABLE _pf_dynamic_test (
    id  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    val VARCHAR(3072) NOT NULL
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

DROP TABLE _pf_dynamic_test;
```

Expected output: `mysql_version` starts with `8.`. `innodb_default_row_format = dynamic`. `innodb_large_prefix` and `innodb_file_format` return empty result sets (correct on 8.0+). `utf8mb4` charset row present. Test table creates and drops without error.

**`innodb_large_prefix` result branches:**
- Empty result set → MySQL 8.0+, always enabled → **GO**
- Row returned, `Value = ON` → MySQL 5.7, enabled → **GO**
- Row returned, `Value = OFF` → MySQL 5.7, disabled → **NO-GO**: run `SET GLOBAL innodb_large_prefix = ON;`, confirm it persists, or upgrade to 8.0 before proceeding

**GO:** MySQL 8.0+, `innodb_default_row_format = dynamic`, `innodb_large_prefix` empty or `ON`, `utf8mb4` available, test table creates and drops cleanly.
**NO-GO:** MySQL < 5.7.6, `innodb_default_row_format` not `dynamic`, `innodb_large_prefix = OFF`, `utf8mb4` missing, or test table fails.
If this fails: If version < 8.0, escalate — the Phase 1 view uses window function syntax requiring 8.0+. If `innodb_large_prefix = OFF`, apply the remediation above. Stop and diagnose before proceeding.

---

**A3. Inventory current schema: tables, columns, indexes, and foreign keys**

What to do: Capture the full current schema shape so all subsequent steps use confirmed column names rather than assumed ones.

Command / Query:
```sql
-- All tables
SELECT table_name, engine, row_format, table_rows, table_collation
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY table_name;

-- All columns
SELECT
    table_name,
    column_name,
    ordinal_position,
    column_type,
    is_nullable,
    column_default,
    column_key,
    extra
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position;

-- All indexes
SELECT
    table_name,
    index_name,
    non_unique,
    seq_in_index,
    column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
ORDER BY table_name, index_name, seq_in_index;

-- All foreign keys
SELECT
    kcu.table_name,
    kcu.constraint_name,
    kcu.column_name,
    kcu.referenced_table_name,
    kcu.referenced_column_name,
    rc.delete_rule,
    rc.update_rule
FROM information_schema.key_column_usage kcu
JOIN information_schema.referential_constraints rc
    ON rc.constraint_name    = kcu.constraint_name
    AND rc.constraint_schema = kcu.table_schema
WHERE kcu.table_schema = DATABASE()
ORDER BY kcu.table_name, kcu.constraint_name;
```

Expected output: At minimum, tables named `games`, `rankings`, and `teams` are present. Record exact column names for `games` (date column, time column, opponent column, home-team column, score columns, is_ot, result, season if present) and for `rankings` (rank column, team identifier column, rating column, source column).

**GO:** All three expected tables present. Column names for games and rankings recorded.
**NO-GO:** Any expected table is missing, or column names differ from DataService.swift assumptions in ways that invalidate downstream queries.
If this fails: Stop. The production schema differs significantly from expectations. Diagnose before continuing.

*Record confirmed column names here before executing A4 onward. All remaining queries use these names.*

---

**A4. Record baseline row counts**

What to do: Capture the exact row count of every current table as the pre-migration baseline for post-migration validation in Section D.

Command / Query:
```sql
SELECT 'games'    AS tbl, COUNT(*) AS row_count FROM games
UNION ALL
SELECT 'rankings',         COUNT(*) FROM rankings
UNION ALL
SELECT 'teams',            COUNT(*) FROM teams;
```

Expected output: Three non-zero rows. The `games` count reflects per-team-perspective storage: Oregon-vs-Oregon games appear twice (once per team's `is_home` row), out-of-state games appear once (only the Oregon team has a row). The backfilled `games` count in the new schema will be lower — this is expected.

**GO:** All three counts are non-zero. Numbers recorded.
**NO-GO:** Any count is zero.
If this fails: If `teams` is zero, the scraper may not be seeding team rows. Investigate before proceeding — the Section D backfill joins through the teams table.

*Record:*
- `games`: ___
- `rankings`: ___
- `teams`: ___

---

**A5. Analyze team identifiers in the current teams table**

What to do: Examine the team identifier column for length, whitespace, mixed case, and duplicates to verify the normalization strategy (LOWER + TRIM) is sufficient.

Command / Query:
```sql
-- Substitute actual team identifier column name from A3

SELECT
    slug                                                        AS raw_value,
    LOWER(TRIM(slug))                                           AS normalized,
    CHAR_LENGTH(slug)                                           AS raw_len,
    CHAR_LENGTH(LOWER(TRIM(slug)))                              AS norm_len,
    CASE WHEN slug != LOWER(TRIM(slug)) THEN 'NEEDS_NORM' ELSE 'ok' END AS status
FROM teams
ORDER BY status DESC, slug;

-- Duplicates after normalization
SELECT LOWER(TRIM(slug)) AS normalized, COUNT(*) AS cnt
FROM teams
GROUP BY LOWER(TRIM(slug))
HAVING cnt > 1;

-- Max length (must fit in VARCHAR(64) in new schema)
SELECT MAX(CHAR_LENGTH(slug)) AS max_len FROM teams;
```

Expected output: All `status = ok`. Zero rows in the duplicates query. Max length ≤ 64.

**GO:** Zero duplicates after normalization. All `status = ok`. Max length ≤ 64.
**NO-GO:** Any duplicate after normalization, any `status = NEEDS_NORM`, or max length > 64.
If this fails: If mixed case exists, document which rows and add aliases accordingly before Section C. If max length > 64, widen the VARCHAR in the Phase 1 DDL before running B1.

---

**A6. Enumerate distinct team_id values used in the games table**

What to do: List every distinct home-team identifier used in games and confirm each has a matching row in the teams table.

Command / Query:
```sql
-- Substitute actual column name from A3

-- All distinct team identifiers in games with frequency
SELECT team_id, COUNT(*) AS game_rows
FROM games
GROUP BY team_id
ORDER BY game_rows DESC;

-- Any that do NOT match a teams row
SELECT DISTINCT g.team_id AS unmatched_team_id
FROM games g
LEFT JOIN teams t ON LOWER(TRIM(t.slug)) = LOWER(TRIM(g.team_id))
WHERE t.slug IS NULL
ORDER BY g.team_id;
```

Expected output: First query returns one row per team in the schedule. Second query returns zero rows.

**GO:** Second query returns zero rows.
**NO-GO:** Second query returns any rows.
If this fails: For each unmatched value, determine whether it is a typo that maps to an existing team or a new team needing a row. Document each case — these must be resolved in C3/C4 before D1 runs.

---

**A7. Enumerate and classify all unresolved team references in games**

What to do: Check both the home-team column and the opponent column for values that cannot be matched to a known team; categorize every unresolved value as out-of-state, Oregon alias variant, or unknown — this list drives the C3 placeholder inserts and C4 alias seeds.

Command / Query:
```sql
-- Substitute actual column names from A3 throughout.
-- Part 1: opponent strings — full resolution status
SELECT
    LOWER(TRIM(g.opponent))                         AS normalized_opponent,
    g.opponent                                      AS raw_opponent,
    COUNT(*)                                        AS occurrences,
    CASE
        WHEN t_slug.slug IS NOT NULL THEN 'resolved_by_slug'
        WHEN t_name.slug IS NOT NULL THEN 'resolved_by_name'
        ELSE 'UNRESOLVED'
    END                                             AS resolution_status,
    COALESCE(t_slug.slug, t_name.slug)              AS resolved_to
FROM games g
LEFT JOIN teams t_slug ON LOWER(TRIM(t_slug.slug)) = LOWER(TRIM(g.opponent))
LEFT JOIN teams t_name ON LOWER(TRIM(t_name.name)) = LOWER(TRIM(g.opponent))
GROUP BY
    LOWER(TRIM(g.opponent)),
    g.opponent,
    t_slug.slug,
    t_name.slug
ORDER BY resolution_status DESC, occurrences DESC;

-- Part 2: count of UNRESOLVED opponent strings only
SELECT COUNT(DISTINCT LOWER(TRIM(g.opponent))) AS unresolved_opponent_count
FROM games g
LEFT JOIN teams t_slug ON LOWER(TRIM(t_slug.slug)) = LOWER(TRIM(g.opponent))
LEFT JOIN teams t_name ON LOWER(TRIM(t_name.name)) = LOWER(TRIM(g.opponent))
WHERE t_slug.slug IS NULL AND t_name.slug IS NULL;
```

After retrieving results, manually classify every `UNRESOLVED` row:

| Category | Action |
|---|---|
| Out-of-state school (e.g., `Borah HS (ID)`) | Seed as placeholder team in C3 with correct `state` code |
| Oregon team — alias variant (e.g., `Mt. View`) | Add alias to C4 seed list |
| Unknown / cannot classify | Stop and investigate |

Expected output: Every Oregon opponent resolves to `resolved_by_slug` or `resolved_by_name`. All `UNRESOLVED` rows are classifiable as out-of-state schools. Zero rows in the "unknown" category. The complete out-of-state placeholder list and Oregon alias addition list are recorded.

**GO:** Zero Oregon teams are `UNRESOLVED`. Every unresolved opponent is positively identified as an out-of-state school. Out-of-state placeholder list and alias seed list are complete.
**NO-GO:** Any recognizable Oregon team name is `UNRESOLVED`, or any row cannot be classified.
If this fails: An unclassifiable opponent means either a data integrity issue or a team missed during MockData setup. Resolve with the person who operates the scraper before proceeding.

*Record all UNRESOLVED rows and their classifications here before proceeding.*

---

**A8. Analyze date column storage format in games**

What to do: Confirm the data type, check for null or invalid dates, and verify stored values are parseable as YYYY-MM-DD.

Command / Query:
```sql
-- Substitute actual column name from A3

SELECT column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name   = 'games'
  AND column_name  = 'date';

-- Null check
SELECT COUNT(*) AS null_dates
FROM games WHERE date IS NULL;

-- Zero-date check using YEAR() — avoids errors under strict SQL mode
-- when the column type is DATE
SELECT COUNT(*) AS zero_or_invalid_dates
FROM games
WHERE YEAR(date) = 0 OR date IS NULL;

-- Format sample (especially relevant if column is VARCHAR)
SELECT DISTINCT LEFT(CAST(date AS CHAR), 10) AS date_prefix, COUNT(*) AS cnt
FROM games
GROUP BY LEFT(CAST(date AS CHAR), 10)
ORDER BY cnt DESC
LIMIT 20;

-- UTC midnight ISO strings (mysql2 serialization artifact on VARCHAR columns)
SELECT COUNT(*) AS utc_midnight_strings
FROM games
WHERE CAST(date AS CHAR) LIKE '%T00:00:00%';

-- Season range sanity check
SELECT MIN(date) AS earliest, MAX(date) AS latest FROM games;
```

Expected output: `null_dates = 0`. `zero_or_invalid_dates = 0`. All `date_prefix` values follow `YYYY-MM-DD`. `utc_midnight_strings` may be non-zero if column is VARCHAR (the D1 backfill uses `DATE(date)` to strip the time portion). Date range is within 2025–2026.

**GO:** Zero null dates. Zero zero/invalid dates. All values parseable as YYYY-MM-DD after `LEFT(..., 10)`. Date range within expected season window.
**NO-GO:** Null dates exist, zero/invalid dates exist, or unparseable formats present.
If this fails: Run `SELECT * FROM games WHERE YEAR(date) = 0 OR date IS NULL` to enumerate anomalous rows. Do not backfill until the source of bad dates is understood.

---

**A9. Analyze time column storage format in games**

What to do: Enumerate every distinct format variant stored in the time column to confirm VARCHAR(8) is adequate and identify any normalization needed.

Command / Query:
```sql
-- Substitute actual column name from A3

SELECT column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name   = 'games'
  AND column_name  = 'time';

-- All distinct time values with frequency
SELECT
    time                    AS stored_value,
    CHAR_LENGTH(time)       AS len,
    COUNT(*)                AS occurrences
FROM games
GROUP BY time
ORDER BY occurrences DESC;

-- Null count
SELECT COUNT(*) AS null_times FROM games WHERE time IS NULL;

-- Max length
SELECT MAX(CHAR_LENGTH(time)) AS max_len FROM games WHERE time IS NOT NULL;
```

Expected output: Values follow `H:MMam/pm` or `HH:MMam/pm` patterns (e.g., `4:30pm`, `11:00am`). Nulls are expected for TBD or scrimmage games. Max length ≤ 8.

**GO:** All non-null values follow 12-hour `H:MMam/pm` or `HH:MMam/pm` pattern. Max length ≤ 8.
**NO-GO:** Values contain 24-hour times, timezone suffixes, or exceed 8 characters.
If this fails: Document every non-standard format. If any value exceeds 8 characters, widen the `game_time VARCHAR(8)` definition in the Phase 1 DDL before B1 runs.

---

**A10. Check for duplicate game rows**

What to do: Detect intra-team duplicates (bugs) and cross-team matchups appearing more than twice (also bugs); two-appearance Oregon-vs-Oregon pairs are expected and handled by D1's INSERT IGNORE.

Command / Query:
```sql
-- Substitute actual column names from A3

-- Intra-team duplicates: same team_id + opponent + date more than once
SELECT
    team_id,
    opponent,
    date,
    COUNT(*) AS cnt
FROM games
GROUP BY team_id, opponent, date
HAVING cnt > 1
ORDER BY cnt DESC;

-- Cross-team pair analysis with LOWER(TRIM()) normalization on both sides.
-- NOTE: This catches literal-string duplicates only. Semantic duplicates
-- (e.g., 'Nelson' and 'Clackamas/Nelson' referring to the same team) are
-- NOT caught here — semantic dedup happens during D1 via team_aliases
-- resolution.

-- Matchups appearing more than twice (anomaly)
SELECT
    LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent)))    AS team_a_norm,
    GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))) AS team_b_norm,
    date,
    COUNT(*) AS appearances
FROM games
GROUP BY
    LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
    GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
    date
HAVING appearances > 2
ORDER BY appearances DESC;

-- Matchups appearing exactly once (out-of-state — expected)
SELECT COUNT(*) AS single_appearance_matchups
FROM (
    SELECT
        LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        date
    FROM games
    GROUP BY
        LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        date
    HAVING COUNT(*) = 1
) x;

-- Matchups appearing exactly twice (Oregon-vs-Oregon — expected)
SELECT COUNT(*) AS double_appearance_matchups
FROM (
    SELECT
        LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        date
    FROM games
    GROUP BY
        LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
        date
    HAVING COUNT(*) = 2
) x;
```

Expected output: First query (intra-team dupes): zero rows. Second query (> 2 appearances): zero rows. `single_appearance_matchups + (double_appearance_matchups × 2)` equals the A4 baseline `games` count.

**GO:** Zero intra-team duplicates. Zero matchups appearing more than twice. Arithmetic matches A4 baseline.
**NO-GO:** Any intra-team duplicate exists, or any matchup appears more than twice.
If this fails: For each anomalous row, identify the scraper run that caused it. Determine whether it is a true data bug or a rescheduled game entered twice. Resolve before D1.

---

**A11. Check the rating column type in the rankings table**

What to do: Confirm whether ratings are stored as FLOAT, DOUBLE, VARCHAR, or DECIMAL — this determines whether the DECIMAL(8,2) migration changes any values.

Command / Query:
```sql
-- Substitute actual column names from A3

SELECT column_name, column_type, is_nullable, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name   = 'rankings'
  AND column_name IN ('rating', 'agd', 'sched', 'consensus');
```

Expected output: One row per rating column. `data_type` is one of `float`, `double`, `decimal`, or `varchar`. Record the exact type — it determines the CAST strategy in A12 and D4.

**GO:** All expected rating columns found. Types recorded.
**NO-GO:** A column is not found (name differs from A3 output).
If this fails: Recheck A3 for the actual column names and re-run.

*Record confirmed column types here: rating=___, agd=___, sched/consensus=___*

---

**A12. Sample rating values to detect FLOAT precision artifacts**

What to do: Compare stored rating values against their DECIMAL(8,2) representations to confirm whether FLOAT drift is present and lock in the backfill CAST strategy.

Command / Query:
```sql
-- Substitute actual team identifier and rating column names from A3
-- throughout this query.

SELECT
    team_name,                                              -- substitute from A3
    rating,                                                 -- substitute from A3
    CAST(rating AS DECIMAL(8,2))         AS rating_decimal,
    CAST(rating AS CHAR)                 AS rating_string,
    rating - CAST(rating AS DECIMAL(8,2)) AS precision_drift
FROM rankings
WHERE team_name IN (                                        -- substitute column from A3
    'Oregon Episcopal',
    'Lakeridge',
    'Clackamas/Nelson',
    'Mountain View',
    'Bend/Caldera'
)
ORDER BY team_name;

-- Count all rows where drift would change the rounded value
SELECT COUNT(*) AS drifted_rows
FROM rankings
WHERE ABS(rating - CAST(rating AS DECIMAL(8,2))) > 0.005;  -- substitute column from A3

-- Same for agd if present
SELECT COUNT(*) AS drifted_agd
FROM rankings
WHERE agd IS NOT NULL
  AND ABS(agd - CAST(agd AS DECIMAL(8,2))) > 0.005;        -- substitute column from A3
```

Expected output: If column is DECIMAL: `precision_drift = 0` for all rows, `drifted_rows = 0`. If column is FLOAT: drift values like `8.881784197001252e-16` appear, `drifted_rows > 0` — confirms the migration fixes a real iOS bug (ratings returned as strings instead of numbers).

**GO:** Query runs without error. Drift presence recorded. The D4 backfill will use `CAST(rating AS DECIMAL(8,2))` regardless.
**NO-GO:** Query fails due to column name mismatch.
If this fails: Substitute correct column names from A3 and re-run.

*Record: FLOAT drift present? Yes / No. Count of drifted rows: ___*

---

**A13. Section A sign-off gate**

What to do: Confirm all audit outputs are recorded and no blocking issues remain before beginning schema changes.

Command / Query:
```sql
-- Final state snapshot: confirm no data changed during pre-flight
SELECT 'games'    AS tbl, COUNT(*) AS row_count FROM games
UNION ALL
SELECT 'rankings',         COUNT(*) FROM rankings
UNION ALL
SELECT 'teams',            COUNT(*) FROM teams;
```

Expected output: Counts match exactly the numbers recorded in A4.

Confirm each item before proceeding:

| # | Item | Status |
|---|---|---|
| 1 | Backup taken and restore verified; spot-checked rows look correct (A1) | ☐ |
| 2 | MySQL 8.0+ confirmed, ROW_FORMAT=DYNAMIC works, large_prefix OK (A2) | ☐ |
| 3 | All current column names recorded from INFORMATION_SCHEMA (A3) | ☐ |
| 4 | Baseline row counts recorded: games=___, rankings=___, teams=___ (A4) | ☐ |
| 5 | Team identifier column clean — no mixed case, no dupes after normalization (A5) | ☐ |
| 6 | All team_id values in games resolve to a teams row (A6) | ☐ |
| 7 | Full opponent inventory complete; all UNRESOLVED classified; out-of-state placeholder list ready; Oregon alias additions documented for C4 (A7) | ☐ |
| 8 | Date column format confirmed; zero null dates; zero zero/invalid dates (A8) | ☐ |
| 9 | Time column max length ≤ 8; all formats documented (A9) | ☐ |
| 10 | Zero intra-team duplicate rows; zero matchups appearing more than twice; arithmetic matches A4 (A10) | ☐ |
| 11 | Rating column types recorded (A11) | ☐ |
| 12 | FLOAT drift presence recorded; CAST strategy confirmed for D4 backfill (A12) | ☐ |
| 13 | Final row counts match A4 baseline (A13) | ☐ |

**GO:** All 13 boxes checked. No open questions. Proceed to Section B.
**NO-GO:** Any box is unchecked or any open question remains unresolved.
If this fails: Do not proceed to Section B until every item is resolved. Schema changes on top of unresolved data anomalies compound into harder-to-fix problems downstream.

*Sign off here (name + timestamp): ___________________________*

---