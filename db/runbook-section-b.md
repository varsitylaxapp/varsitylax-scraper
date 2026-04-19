# VarsityLax Phase 3 Migration Runbook — Section B: Schema Creation

> **IDEMPOTENCY WARNING:** The DDL in B3 uses `CREATE TABLE IF NOT EXISTS`. This silently succeeds even when an existing table's schema has drifted from the DDL — it does **not** verify that the existing table matches the intended structure. If B3 is interrupted and re-run, the B4 existence and FK checks are mandatory before proceeding. Do not assume a clean re-run means a correct schema.

> **game_source_priority seed:** The three reference rows (ohsla, laxnumbers, laxpower) are inserted at the end of B3 immediately after the table is created. This ensures `games.canonical_source` FK targets exist before Section D backfills any game rows. Section C does **not** need to re-seed this table.

*The first irreversible action in Section B is B1 (RENAME TABLE). Steps after B1 cannot be cleanly undone without the restore from A1. All of Section A must be signed off before entering Section B.*

---

**B1. Rename all conflicting old tables to `*_v1` (atomic — last safe abort point)**

What to do: In a single atomic RENAME TABLE statement, move every old production table whose name conflicts with a Phase 1 canonical table name to a `_v1` suffix; this clears the namespace for B3 and is the point of no easy return.

> **⚠ LAST SAFE ABORT POINT.** After this statement executes, the running application will query the new (empty) tables and return no data. The v1 API endpoints must be updated to query `*_v1` table names before or immediately after this step — coordinate the deployment accordingly. Confirm the A1 backup is restorable and all of Section A is signed off before executing.

> **Check A3 output first.** The RENAME below covers the minimum known set (games, rankings, teams). If A3 revealed additional tables whose names conflict with Phase 1 canonical names, add them to this statement before running.

Command / Query:
```sql
-- Single atomic statement. If any name is wrong the entire statement
-- fails and nothing is renamed.
RENAME TABLE
    games    TO games_v1,
    rankings TO rankings_v1,
    teams    TO teams_v1;
```

After the rename, MySQL automatically updates any FK references on `games_v1` or `rankings_v1` that pointed to the old `teams` table to now reference `teams_v1`. Verify this explicitly:

```sql
-- Confirm *_v1 tables exist and hold the A4 baseline counts
SELECT 'games_v1',    COUNT(*) AS row_count FROM games_v1
UNION ALL
SELECT 'rankings_v1', COUNT(*) FROM rankings_v1
UNION ALL
SELECT 'teams_v1',    COUNT(*) FROM teams_v1;
```

```sql
-- Confirm FKs on *_v1 tables now reference *_v1 names.
-- Look for REFERENCES `teams_v1` (not `teams`) in the output.
SHOW CREATE TABLE games_v1;
SHOW CREATE TABLE rankings_v1;
```

Expected output: All three `*_v1` counts match A4 baseline exactly. `SHOW CREATE TABLE games_v1` output shows any FK referencing `teams_v1`, not `teams`. `SHOW CREATE TABLE rankings_v1` likewise.

**GO:** All three counts match A4. FKs on `*_v1` tables reference `*_v1` names.
**NO-GO:** Any count doesn't match A4, RENAME fails, or a FK still references the bare `teams` name.
If this fails: If RENAME errors with `Table doesn't exist`, recheck table names against A3 output and reissue with correct names. If a count doesn't match baseline, stop — data may have been written between A4 and now; diagnose before continuing. To roll back: `RENAME TABLE games_v1 TO games, rankings_v1 TO rankings, teams_v1 TO teams;`

---

**B2. Confirm canonical table names are now free**

What to do: Verify that none of the Phase 1 canonical table names are occupied before running the DDL in B3.

Command / Query:
```sql
-- All 12 Phase 1 canonical names must return 0 rows here.
-- Any row returned means a name conflict that will cause B3 to
-- silently no-op (IF NOT EXISTS) on that table.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
      'game_source_priority',
      'venues',
      'teams',
      'team_aliases',
      'team_seasons',
      'coaches',
      'team_coaches',
      'games',
      'game_source_records',
      'unresolved_aliases',
      'rankings_snapshots',
      'ranking_entries'
  )
ORDER BY table_name;
```

Expected output: Zero rows.

**GO:** Zero rows returned.
**NO-GO:** Any row returned — a canonical name is still occupied.
If this fails: Identify which table is still present, confirm it was supposed to be renamed in B1, and either add it to the B1 RENAME or drop it after confirming it contains no production data that isn't already covered by a `*_v1` copy.

---

**B3. Execute full Phase 1 DDL and seed game_source_priority**

What to do: Run the complete CREATE TABLE block in FK-dependency order, then immediately insert the three game_source_priority reference rows so FK targets exist before any game row is written.

> **If this step is interrupted mid-run:** Do not attempt to run only the missing CREATE statements. Drop everything created so far using the cleanup block at the bottom of this step, then restart B3 from the beginning. Partial schema creation leaves FK dependency state inconsistent and the cleanup block is the only safe restart path.

Command / Query:
```sql
-- ── 1. game_source_priority ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_source_priority (
    source    VARCHAR(32)  NOT NULL,
    priority  INT          NOT NULL,
    notes     VARCHAR(256) NULL,
    PRIMARY KEY (source)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- Seed immediately — games.canonical_source FK targets must exist before D1
INSERT INTO game_source_priority (source, priority, notes) VALUES
    ('ohsla',      100, 'OHSLA official — authoritative for home/away and scores'),
    ('laxnumbers',  50, 'LaxNumbers scraper'),
    ('laxpower',     0, 'LaxPower scraper — rankings only, no game data')
ON DUPLICATE KEY UPDATE priority = VALUES(priority), notes = VALUES(notes);

-- ── 2. venues ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venues (
    id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    name       VARCHAR(128)  NOT NULL,
    address    VARCHAR(256)  NULL,
    city       VARCHAR(64)   NOT NULL,
    state      CHAR(2)       NOT NULL DEFAULT 'OR',
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_venues_name_city (name, city)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 3. teams ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
    id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    slug          VARCHAR(64)   NOT NULL,
    name          VARCHAR(128)  NOT NULL,
    mascot        VARCHAR(64)   NULL,
    city          VARCHAR(64)   NULL,
    state         CHAR(2)       NOT NULL DEFAULT 'OR',
    country       VARCHAR(2)    NULL,
    home_venue_id INT UNSIGNED  NULL,
    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_teams_slug (slug),
    CONSTRAINT fk_teams_venue
        FOREIGN KEY (home_venue_id) REFERENCES venues (id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 4. team_aliases ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_aliases (
    id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    team_id          INT UNSIGNED  NOT NULL,
    alias            VARCHAR(128)  NOT NULL,
    alias_normalized VARCHAR(128)
        GENERATED ALWAYS AS (LOWER(TRIM(alias))) STORED NOT NULL,
    source           VARCHAR(64)   NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_team_aliases_normalized (alias_normalized),
    KEY idx_team_aliases_team_id (team_id),
    CONSTRAINT fk_team_aliases_team
        FOREIGN KEY (team_id) REFERENCES teams (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 5. team_seasons ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_seasons (
    id             INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    team_id        INT UNSIGNED      NOT NULL,
    season         SMALLINT UNSIGNED NOT NULL,
    conference     VARCHAR(64)       NULL,
    division       VARCHAR(64)       NULL,
    wins           TINYINT UNSIGNED  NOT NULL DEFAULT 0,
    losses         TINYINT UNSIGNED  NOT NULL DEFAULT 0,
    wl_computed_at DATETIME          NULL,
    created_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_team_seasons (team_id, season),
    CONSTRAINT fk_team_seasons_team
        FOREIGN KEY (team_id) REFERENCES teams (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 6. coaches ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coaches (
    id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    full_name  VARCHAR(128)  NOT NULL,
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 7. team_coaches ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_coaches (
    id         INT UNSIGNED             NOT NULL AUTO_INCREMENT,
    team_id    INT UNSIGNED             NOT NULL,
    coach_id   INT UNSIGNED             NOT NULL,
    season     SMALLINT UNSIGNED        NOT NULL,
    role       ENUM('head','assistant') NOT NULL,
    source     VARCHAR(64)              NULL,
    created_at DATETIME                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_team_coaches (team_id, coach_id, role, season),
    CONSTRAINT fk_team_coaches_team
        FOREIGN KEY (team_id) REFERENCES teams (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_team_coaches_coach
        FOREIGN KEY (coach_id) REFERENCES coaches (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 8. games ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
    id                INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    season            SMALLINT UNSIGNED NOT NULL,
    home_team_id      INT UNSIGNED      NOT NULL,
    away_team_id      INT UNSIGNED      NOT NULL,
    game_date         DATE              NOT NULL,
    game_datetime     DATETIME          NULL,
    venue_id          INT UNSIGNED      NULL,
    is_conference     TINYINT(1)        NOT NULL DEFAULT 0,
    is_overtime       TINYINT(1)        NOT NULL DEFAULT 0,
    is_scrimmage      TINYINT(1)        NOT NULL DEFAULT 0,
    home_score        SMALLINT UNSIGNED NULL,
    away_score        SMALLINT UNSIGNED NULL,
    status            ENUM('scheduled','completed','cancelled','postponed')
                                        NOT NULL DEFAULT 'scheduled',
    status_note       VARCHAR(256)      NULL,
    canonical_source  VARCHAR(32)       NULL,
    source_updated_at DATETIME          NULL,
    has_conflict      TINYINT(1)        NOT NULL DEFAULT 0,
    created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_game (season, home_team_id, away_team_id, game_date),
    KEY idx_games_home_team (home_team_id),
    KEY idx_games_away_team (away_team_id),
    KEY idx_games_date (game_date),
    CONSTRAINT fk_games_home_team
        FOREIGN KEY (home_team_id) REFERENCES teams (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_games_away_team
        FOREIGN KEY (away_team_id) REFERENCES teams (id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_games_venue
        FOREIGN KEY (venue_id) REFERENCES venues (id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_games_source
        FOREIGN KEY (canonical_source) REFERENCES game_source_priority (source)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 9. game_source_records ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_source_records (
    id                   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    game_id              INT UNSIGNED      NOT NULL,
    source               VARCHAR(32)       NOT NULL,
    source_game_date     DATE              NULL,
    source_game_datetime DATETIME          NULL,
    home_team_raw        VARCHAR(128)      NULL,
    away_team_raw        VARCHAR(128)      NULL,
    home_score           SMALLINT UNSIGNED NULL,
    away_score           SMALLINT UNSIGNED NULL,
    is_overtime          TINYINT(1)        NULL,
    is_conference        TINYINT(1)        NULL,
    venue_name_raw       VARCHAR(128)      NULL,
    raw_payload          JSON              NULL,
    scraped_at           DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_game_source (game_id, source),
    CONSTRAINT fk_gsr_game
        FOREIGN KEY (game_id) REFERENCES games (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 10. unresolved_aliases ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unresolved_aliases (
    id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    raw_name         VARCHAR(128)  NOT NULL,
    source           VARCHAR(32)   NOT NULL,
    context          VARCHAR(256)  NULL,
    first_seen_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    occurrence_count INT UNSIGNED  NOT NULL DEFAULT 1,
    resolved_team_id INT UNSIGNED  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_unresolved (raw_name, source),
    CONSTRAINT fk_unresolved_team
        FOREIGN KEY (resolved_team_id) REFERENCES teams (id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 11. rankings_snapshots ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rankings_snapshots (
    id           INT UNSIGNED                  NOT NULL AUTO_INCREMENT,
    source       ENUM('laxnumbers','laxpower') NOT NULL,
    season       SMALLINT UNSIGNED             NOT NULL,
    captured_at  DATETIME                      NOT NULL,
    content_hash CHAR(64)                      NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_snapshot (source, season, captured_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 12. ranking_entries ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ranking_entries (
    snapshot_id   INT UNSIGNED      NOT NULL,
    team_id       INT UNSIGNED      NOT NULL,
    rank_position TINYINT UNSIGNED  NOT NULL,
    rating        DECIMAL(8,2)      NOT NULL,
    agd           DECIMAL(8,2)      NULL,
    sched         DECIMAL(8,2)      NULL,
    record_wins   TINYINT UNSIGNED  NULL,
    record_losses TINYINT UNSIGNED  NULL,
    PRIMARY KEY (snapshot_id, team_id),
    KEY idx_snapshot_rank_pos (snapshot_id, rank_position),
    CONSTRAINT fk_re_snapshot
        FOREIGN KEY (snapshot_id) REFERENCES rankings_snapshots (id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_re_team
        FOREIGN KEY (team_id) REFERENCES teams (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- ── 13. v_team_season_record (view — last; depends on games) ─────────────
CREATE OR REPLACE VIEW v_team_season_record AS
SELECT team_id, season,
    SUM(CASE WHEN my_score > opp_score THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN my_score < opp_score THEN 1 ELSE 0 END) AS losses
FROM (
    SELECT home_team_id AS team_id, season,
           home_score   AS my_score,
           away_score   AS opp_score
    FROM games
    WHERE status       = 'completed'
      AND is_scrimmage = 0
      AND home_score   IS NOT NULL
      AND away_score   IS NOT NULL
    UNION ALL
    SELECT away_team_id AS team_id, season,
           away_score   AS my_score,
           home_score   AS opp_score
    FROM games
    WHERE status       = 'completed'
      AND is_scrimmage = 0
      AND home_score   IS NOT NULL
      AND away_score   IS NOT NULL
) g
GROUP BY team_id, season;
```

If B3 is interrupted and must be restarted, drop in reverse FK order before re-running:

```sql
-- Run ONLY if B3 was interrupted. Do NOT run after a successful B3.
DROP VIEW  IF EXISTS v_team_season_record;
DROP TABLE IF EXISTS ranking_entries;
DROP TABLE IF EXISTS rankings_snapshots;
DROP TABLE IF EXISTS unresolved_aliases;
DROP TABLE IF EXISTS game_source_records;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS team_coaches;
DROP TABLE IF EXISTS coaches;
DROP TABLE IF EXISTS team_seasons;
DROP TABLE IF EXISTS team_aliases;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS venues;
DROP TABLE IF EXISTS game_source_priority;
```

Expected output: 12 `CREATE TABLE` statements, 1 `CREATE OR REPLACE VIEW`, and 1 `INSERT` complete without error. No `Table already exists` errors (B2 confirmed the namespace was clear).

**GO:** All 14 statements complete without error. `game_source_priority` contains 3 rows.
**NO-GO:** Any statement errors.
If this fails: Run the cleanup block above, identify the failing statement, fix it, then re-run B3 from the top. Do not attempt to fill in only the missing tables.

---

**B4. Verify all 12 new tables, the view, unique keys, FKs, generated column, and seed data**

What to do: Confirm the schema created in B3 exactly matches the Phase 1 specification before any data is written to it.

Command / Query:
```sql
-- All 12 new tables present (expect exactly 12 rows)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
      'game_source_priority',
      'venues',
      'teams',
      'team_aliases',
      'team_seasons',
      'coaches',
      'team_coaches',
      'games',
      'game_source_records',
      'unresolved_aliases',
      'rankings_snapshots',
      'ranking_entries'
  )
ORDER BY table_name;
```

```sql
-- View exists
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name = 'v_team_season_record';
```

```sql
-- All 8 critical unique keys present (expect exactly 8 rows)
SELECT table_name, index_name, column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND (table_name, index_name) IN (
      ('games',               'uq_game'),
      ('teams',               'uq_teams_slug'),
      ('team_aliases',        'uq_team_aliases_normalized'),
      ('team_seasons',        'uq_team_seasons'),
      ('team_coaches',        'uq_team_coaches'),
      ('game_source_records', 'uq_game_source'),
      ('rankings_snapshots',  'uq_snapshot'),
      ('unresolved_aliases',  'uq_unresolved')
  )
ORDER BY table_name, index_name;
```

```sql
-- Generated column on team_aliases is STORED
SELECT column_name, extra, generation_expression
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name   = 'team_aliases'
  AND column_name  = 'alias_normalized';
```

```sql
-- All FK constraints present
SELECT table_name, constraint_name, referenced_table_name
FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE()
ORDER BY table_name, constraint_name;
```

```sql
-- All new tables empty except game_source_priority
SELECT 'game_source_priority' AS tbl, COUNT(*) AS rows FROM game_source_priority
UNION ALL SELECT 'venues',               COUNT(*) FROM venues
UNION ALL SELECT 'teams',               COUNT(*) FROM teams
UNION ALL SELECT 'team_aliases',        COUNT(*) FROM team_aliases
UNION ALL SELECT 'team_seasons',        COUNT(*) FROM team_seasons
UNION ALL SELECT 'coaches',             COUNT(*) FROM coaches
UNION ALL SELECT 'team_coaches',        COUNT(*) FROM team_coaches
UNION ALL SELECT 'games',              COUNT(*) FROM games
UNION ALL SELECT 'game_source_records', COUNT(*) FROM game_source_records
UNION ALL SELECT 'unresolved_aliases',  COUNT(*) FROM unresolved_aliases
UNION ALL SELECT 'rankings_snapshots',  COUNT(*) FROM rankings_snapshots
UNION ALL SELECT 'ranking_entries',     COUNT(*) FROM ranking_entries;
```

```sql
-- game_source_priority has exactly 3 seed rows in correct priority order
SELECT source, priority, notes
FROM game_source_priority
ORDER BY priority DESC;
```

Expected output: First query returns exactly 12 rows. View query returns 1 row with `TABLE_TYPE = VIEW`. Unique keys query returns 8 rows. `alias_normalized` shows `extra` contains `STORED GENERATED` and `generation_expression = lower(trim(alias))`. FK query shows one row per constraint defined in B3. Row count query shows `game_source_priority = 3`, all other tables `= 0`. Seed query shows ohsla/100, laxnumbers/50, laxpower/0.

**GO:** All assertions above are true.
**NO-GO:** Any table missing, any unique key or FK absent, generated column not STORED, any table other than `game_source_priority` has rows > 0, or `game_source_priority` does not have exactly 3 rows.
If this fails: Run the B3 cleanup block, identify what was wrong, fix the DDL, then re-run B3 and B4 from the top.

---

**B5. Section B sign-off gate**

What to do: Confirm the production database is in the correct post-B state before Section C seeds reference data.

Command / Query:
```sql
-- All expected tables present
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY table_name;
```

```sql
-- Old data intact under *_v1 names
SELECT 'games_v1',    COUNT(*) AS rows FROM games_v1
UNION ALL
SELECT 'rankings_v1', COUNT(*) FROM rankings_v1
UNION ALL
SELECT 'teams_v1',    COUNT(*) FROM teams_v1;
```

Expected output: Table list includes all 12 new tables, the view, and all `*_v1` legacy tables. Legacy counts match A4 baseline.

| # | Item | Status |
|---|---|---|
| 1 | Old tables renamed to `*_v1`; all three counts match A4 baseline (B1) | ☐ |
| 2 | FKs on `games_v1` and `rankings_v1` confirmed to reference `*_v1` names (B1) | ☐ |
| 3 | All 12 Phase 1 canonical names confirmed free before DDL ran (B2) | ☐ |
| 4 | All 12 tables and view created without error (B3) | ☐ |
| 5 | `game_source_priority` seeded: ohsla/100, laxnumbers/50, laxpower/0 (B3) | ☐ |
| 6 | All 8 unique keys present (B4) | ☐ |
| 7 | `alias_normalized` confirmed STORED GENERATED (B4) | ☐ |
| 8 | All FK constraints present (B4) | ☐ |
| 9 | All tables except `game_source_priority` have 0 rows (B4) | ☐ |
| 10 | v1 API endpoints updated to query `*_v1` table names and confirmed returning data | ☐ |

**GO:** All 10 boxes checked. Proceed to Section C.
**NO-GO:** Any box unchecked.
If this fails: If old data is inaccessible from `*_v1` tables, restore from A1 backup immediately and diagnose before any further action.

*Sign off here (name + timestamp): ___________________________*

---

*End of Section B. Section C seeds reference data (venues, teams, aliases, team\_seasons, coaches) into the new tables.*