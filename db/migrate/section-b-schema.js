// Runbook Section B — Phase 1 schema creation, adapted to actual production state.
//
// ADAPTATION vs runbook (approved 2026-07-10): B1's RENAME TABLE is skipped because
// production table names (team_schedules, laxnumbers_rankings, laxpower_rankings,
// scrape_log) do not collide with any Phase 1 canonical name. Old tables stay live;
// the v1 API keeps serving from them untouched. B2's namespace check still gates B3.
//
// DDL below is VERBATIM from db/runbook-section-b.md B3 (locked file).
// One fix applied to B4's verification query: `AS rows` -> `AS row_count`
// (ROWS is a reserved word in MySQL 8.0+).
//
// Usage (from varsitylax-scraper/):
//   node db/migrate/section-b-schema.js            # B2 check + B3 DDL + B4 verify
//   node db/migrate/section-b-schema.js --verify   # B4 verification only (no DDL)
//   node db/migrate/section-b-schema.js --cleanup  # DROP block — ONLY after an interrupted B3
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CANONICAL = ['game_source_priority','venues','teams','team_aliases','team_seasons',
  'coaches','team_coaches','games','game_source_records','unresolved_aliases',
  'rankings_snapshots','ranking_entries'];

const DDL = [
['game_source_priority', `CREATE TABLE IF NOT EXISTS game_source_priority (
    source    VARCHAR(32)  NOT NULL,
    priority  INT          NOT NULL,
    notes     VARCHAR(256) NULL,
    PRIMARY KEY (source)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['seed game_source_priority', `INSERT INTO game_source_priority (source, priority, notes) VALUES
    ('ohsla',      100, 'OHSLA official — authoritative for home/away and scores'),
    ('laxnumbers',  50, 'LaxNumbers scraper'),
    ('laxpower',     0, 'LaxPower scraper — rankings only, no game data')
ON DUPLICATE KEY UPDATE priority = VALUES(priority), notes = VALUES(notes)`],
['venues', `CREATE TABLE IF NOT EXISTS venues (
    id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    name       VARCHAR(128)  NOT NULL,
    address    VARCHAR(256)  NULL,
    city       VARCHAR(64)   NOT NULL,
    state      CHAR(2)       NOT NULL DEFAULT 'OR',
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_venues_name_city (name, city)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['teams', `CREATE TABLE IF NOT EXISTS teams (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['team_aliases', `CREATE TABLE IF NOT EXISTS team_aliases (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['team_seasons', `CREATE TABLE IF NOT EXISTS team_seasons (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['coaches', `CREATE TABLE IF NOT EXISTS coaches (
    id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    full_name  VARCHAR(128)  NOT NULL,
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['team_coaches', `CREATE TABLE IF NOT EXISTS team_coaches (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['games', `CREATE TABLE IF NOT EXISTS games (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['game_source_records', `CREATE TABLE IF NOT EXISTS game_source_records (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['unresolved_aliases', `CREATE TABLE IF NOT EXISTS unresolved_aliases (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['rankings_snapshots', `CREATE TABLE IF NOT EXISTS rankings_snapshots (
    id           INT UNSIGNED                  NOT NULL AUTO_INCREMENT,
    source       ENUM('laxnumbers','laxpower') NOT NULL,
    season       SMALLINT UNSIGNED             NOT NULL,
    captured_at  DATETIME                      NOT NULL,
    content_hash CHAR(64)                      NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_snapshot (source, season, captured_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['ranking_entries', `CREATE TABLE IF NOT EXISTS ranking_entries (
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
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4`],
['v_team_season_record', `CREATE OR REPLACE VIEW v_team_season_record AS
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
GROUP BY team_id, season`],
];

const CLEANUP = [
  'DROP VIEW  IF EXISTS v_team_season_record',
  'DROP TABLE IF EXISTS ranking_entries',
  'DROP TABLE IF EXISTS rankings_snapshots',
  'DROP TABLE IF EXISTS unresolved_aliases',
  'DROP TABLE IF EXISTS game_source_records',
  'DROP TABLE IF EXISTS games',
  'DROP TABLE IF EXISTS team_coaches',
  'DROP TABLE IF EXISTS coaches',
  'DROP TABLE IF EXISTS team_seasons',
  'DROP TABLE IF EXISTS team_aliases',
  'DROP TABLE IF EXISTS teams',
  'DROP TABLE IF EXISTS venues',
  'DROP TABLE IF EXISTS game_source_priority',
];

async function main() {
  const mode = process.argv[2] || '';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });
  const report = [`# Section B Report\n\nGenerated: ${new Date().toISOString()}\nMode: ${mode || 'full run'}\n`];

  if (mode === '--cleanup') {
    console.log('CLEANUP MODE — dropping Phase 1 tables in reverse FK order.');
    console.log('Only valid after an INTERRUPTED B3. Ctrl-C within 5s to abort...');
    await new Promise(r => setTimeout(r, 5000));
    for (const sql of CLEANUP) { await conn.query(sql); console.log('ok:', sql); }
    await conn.end();
    return console.log('Cleanup complete. Re-run without flags to restart B3.');
  }

  if (mode !== '--verify') {
    // ── B2: namespace check ──
    const [occupied] = await conn.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${CANONICAL.map(() => '?').join(',')})`,
      CANONICAL);
    if (occupied.length) {
      console.error('B2 NO-GO — canonical names occupied:', occupied.map(r => r.table_name || r.TABLE_NAME).join(', '));
      console.error('If a prior B3 run was interrupted, run with --cleanup first. Aborting — no DDL executed.');
      await conn.end();
      process.exit(1);
    }
    report.push('## B2 namespace check\n\nAll 12 canonical names free. **GO**\n');
    console.log('B2: namespace clear — GO');

    // ── B3: DDL ──
    report.push('## B3 DDL execution\n');
    for (const [name, sql] of DDL) {
      try {
        await conn.query(sql);
        console.log('B3 ok:', name);
        report.push(`- ${name}: ok`);
      } catch (e) {
        console.error(`B3 FAILED at "${name}": ${e.message}`);
        console.error('Per runbook: run --cleanup, fix, re-run B3 from the top. Do NOT patch partially.');
        report.push(`- ${name}: **FAILED** — ${e.message}`);
        fs.writeFileSync(path.join(__dirname, 'out', 'section-b-report.md'), report.join('\n'));
        await conn.end();
        process.exit(1);
      }
    }
  }

  // ── B4: verification ──
  report.push('\n## B4 verification\n');
  const checks = [];
  const [tbls] = await conn.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${CANONICAL.map(() => '?').join(',')})`, CANONICAL);
  checks.push(['12 tables present', tbls.length === 12, `found ${tbls.length}`]);

  const [view] = await conn.query(
    `SELECT table_type FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'v_team_season_record'`);
  checks.push(['view present', view.length === 1 && /VIEW/i.test(view[0].table_type || view[0].TABLE_TYPE), JSON.stringify(view)]);

  const [uks] = await conn.query(
    `SELECT DISTINCT table_name, index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND (table_name, index_name) IN (
       ('games','uq_game'),('teams','uq_teams_slug'),('team_aliases','uq_team_aliases_normalized'),
       ('team_seasons','uq_team_seasons'),('team_coaches','uq_team_coaches'),
       ('game_source_records','uq_game_source'),('rankings_snapshots','uq_snapshot'),
       ('unresolved_aliases','uq_unresolved'))`);
  checks.push(['8 unique keys present', uks.length === 8, `found ${uks.length}`]);

  const [gen] = await conn.query(
    `SELECT extra, generation_expression FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'team_aliases' AND column_name = 'alias_normalized'`);
  const genOk = gen.length === 1 && /STORED GENERATED/i.test(gen[0].extra || gen[0].EXTRA);
  checks.push(['alias_normalized STORED GENERATED', genOk, JSON.stringify(gen)]);

  const [fkRows] = await conn.query(
    `SELECT table_name, constraint_name, referenced_table_name
     FROM information_schema.referential_constraints
     WHERE constraint_schema = DATABASE() ORDER BY table_name, constraint_name`);
  const expectedFks = ['fk_teams_venue','fk_team_aliases_team','fk_team_seasons_team','fk_team_coaches_team',
    'fk_team_coaches_coach','fk_games_home_team','fk_games_away_team','fk_games_venue','fk_games_source',
    'fk_gsr_game','fk_unresolved_team','fk_re_snapshot','fk_re_team'];
  const fkNames = fkRows.map(r => r.constraint_name || r.CONSTRAINT_NAME);
  const missingFks = expectedFks.filter(f => !fkNames.includes(f));
  checks.push(['13 FK constraints present', missingFks.length === 0, missingFks.length ? 'missing: ' + missingFks.join(', ') : 'all present']);

  let countsOk = true; const countLines = [];
  for (const t of CANONICAL) {
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    const expected = t === 'game_source_priority' ? 3 : 0;
    if (c !== expected) countsOk = false;
    countLines.push(`${t}: ${c} (expected ${expected})`);
  }
  checks.push(['row counts (all 0 except seed=3)', countsOk, countLines.join('; ')]);

  const [seed] = await conn.query(`SELECT source, priority FROM game_source_priority ORDER BY priority DESC`);
  const seedOk = JSON.stringify(seed.map(r => [r.source, r.priority])) === JSON.stringify([['ohsla',100],['laxnumbers',50],['laxpower',0]]);
  checks.push(['seed rows ohsla/100, laxnumbers/50, laxpower/0', seedOk, JSON.stringify(seed)]);

  // Legacy tables untouched (adaptation of B5 item 1: no rename happened, verify old tables still present)
  const [legacy] = await conn.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()
     AND table_name IN ('team_schedules','laxnumbers_rankings','laxpower_rankings','scrape_log')`);
  checks.push(['4 legacy tables still present (v1 API unaffected)', legacy.length === 4, `found ${legacy.length}`]);

  let allGo = true;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'GO ' : 'NO-GO'}  ${name}${ok ? '' : ' — ' + detail}`);
    report.push(`- ${ok ? '✅' : '❌'} ${name} — ${detail}`);
    if (!ok) allGo = false;
  }
  report.push(`\n## Section B: ${allGo ? '**GO — proceed to Section C**' : '**NO-GO — see failures above**'}\n`);
  console.log(`\nSection B overall: ${allGo ? 'GO' : 'NO-GO'}`);

  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'section-b-report.md'), report.join('\n'));
  console.log('Report: db/migrate/out/section-b-report.md');
  await conn.end();
  if (!allGo) process.exit(1);
}

main().catch(e => { console.error('SECTION B FAILED:', e.message); process.exit(1); });
