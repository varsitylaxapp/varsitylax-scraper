// Runbook Section D — data backfill, adapted to actual production state.
//
// ADAPTATIONS vs runbook (approved during execution):
//  - games_v1 -> team_schedules; is_ot -> is_overtime; is_scrimmage = 0 (no legacy column).
//  - RUNBOOK BUG FIX: D1 INSERT now includes `season` (games.season is NOT NULL with no
//    default; the runbook's column list omitted it and would fail under strict mode).
//  - RUNBOOK BUG FIX: D1's dedup NOT EXISTS compared raw strings literally
//    (g2.team_id = LOWER(g.opponent)) — never true for co-op display names like
//    'Grant - Central Eastside', which would double-insert every co-op game and hit
//    uq_game. Dedup now resolves BOTH sides through team_aliases. D2's expected-count
//    query gets the same alias-resolved treatment (literal LEAST/GREATEST overcounts).
//  - 'Team Place Holder' rows (9, scoreless, logged in unresolved_aliases) excluded
//    from both the backfill and the parity count.
//  - All new<->legacy joins wrapped in CONVERT ... COLLATE utf8mb4_general_ci
//    (legacy = general_ci, new = 0900_ai_ci).
//  - D7 backfills from laxnumbers_rankings + laxpower_rankings (rankings_v1 never
//    existed). One snapshot per source at MAX(scraped_at); laxpower.consensus -> rating.
//
// D1 is NOT idempotent (per runbook). If games already has rows, the script aborts;
// use --reset to TRUNCATE games + game_source_records + rankings backfill and start over.
// Usage (from varsitylax-scraper/):  node db/migrate/section-d-backfill.js [--reset]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Collation-safe equality between a new-schema expression and a legacy expression
const EQ = (newExpr, legacyExpr) =>
  `CONVERT(${newExpr} USING utf8mb4) COLLATE utf8mb4_general_ci = CONVERT(${legacyExpr} USING utf8mb4) COLLATE utf8mb4_general_ci`;

const PLACEHOLDER = `g.opponent != 'Team Place Holder'`;

const report = [`# Section D Report\n\nGenerated: ${new Date().toISOString()}\n`];
const gates = [];
function gate(name, ok, detail) {
  gates.push([name, ok, detail]);
  console.log(`${ok ? 'GO   ' : 'NO-GO'}  ${name}${detail ? ' — ' + detail : ''}`);
  report.push(`- ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });

  // ── Pre-flight: D1 is not idempotent ──
  const [[{ existing }]] = await conn.query('SELECT COUNT(*) AS existing FROM games');
  if (existing > 0) {
    if (process.argv.includes('--reset')) {
      console.log(`--reset: clearing ${existing} games + source records + rankings backfill...`);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.query('TRUNCATE TABLE game_source_records');
      await conn.query('TRUNCATE TABLE games');
      await conn.query('TRUNCATE TABLE ranking_entries');
      await conn.query('TRUNCATE TABLE rankings_snapshots');
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } else {
      console.error(`ABORT: games has ${existing} rows and D1 is not idempotent (runbook warning).`);
      console.error('Re-run with --reset to truncate games/game_source_records/rankings backfill and restart D1.');
      await conn.end();
      process.exit(1);
    }
  }

  // ── Pre-check: OR-vs-OR pairs whose two perspectives disagree on home (both or neither claim home).
  // Such pairs would produce two rows with swapped home/away that uq_game canNOT absorb —
  // they must be resolved manually before D1 runs. ──
  const [pairAnomalies] = await conn.query(
    `SELECT LEAST(a_our.team_id, a_opp.team_id) AS ta,
            GREATEST(a_our.team_id, a_opp.team_id) AS tb,
            DATE(g.game_date) AS d,
            COUNT(*) AS perspectives,
            SUM(g.is_home) AS home_claims
     FROM team_schedules g
     JOIN team_aliases a_our ON ${EQ('a_our.alias_normalized', 'LOWER(TRIM(g.team_id))')}
     JOIN team_aliases a_opp ON ${EQ('a_opp.alias_normalized', 'LOWER(TRIM(g.opponent))')}
     WHERE ${PLACEHOLDER}
     GROUP BY ta, tb, d
     HAVING perspectives = 2 AND home_claims != 1`);
  gate('D1 pre-check: no OR-vs-OR home/away disagreements', pairAnomalies.length === 0,
    pairAnomalies.length ? `${pairAnomalies.length} pairs with home_claims != 1 — see JSON in report` : 'all two-perspective pairs have exactly one home claim');
  if (pairAnomalies.length) report.push('```json\n' + JSON.stringify(pairAnomalies, null, 2) + '\n```');

  // ── D1: backfill games ──
  const dedupNotExists = `NOT EXISTS (
        SELECT 1 FROM team_schedules g2
        JOIN team_aliases b_our ON ${EQ('b_our.alias_normalized', 'LOWER(TRIM(g2.team_id))')}
        JOIN team_aliases b_opp ON ${EQ('b_opp.alias_normalized', 'LOWER(TRIM(g2.opponent))')}
        WHERE g2.is_home = 1
          AND b_our.team_id = opp_ta.team_id
          AND b_opp.team_id = our_ta.team_id
          AND DATE(g2.game_date) = DATE(g.game_date)
   )`;
  const [d1] = await conn.query(
    `INSERT INTO games (
        season, home_team_id, away_team_id, game_date, game_datetime, venue_id,
        is_conference, is_overtime, is_scrimmage, home_score, away_score,
        status, canonical_source, created_at
     )
     SELECT
        g.season,
        CASE WHEN g.is_home = 1 THEN our_t.id ELSE opp_t.id END,
        CASE WHEN g.is_home = 1 THEN opp_t.id ELSE our_t.id END,
        DATE(g.game_date),
        NULL,
        CASE WHEN g.is_home = 1 THEN our_t.home_venue_id ELSE opp_t.home_venue_id END,
        g.is_conference,
        g.is_ot,
        0,
        CASE WHEN g.is_home = 1 THEN g.team_score ELSE g.opp_score END,
        CASE WHEN g.is_home = 1 THEN g.opp_score ELSE g.team_score END,
        CASE WHEN g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
             THEN 'completed' ELSE 'scheduled' END,
        NULL,
        NOW()
     FROM team_schedules g
     JOIN team_aliases our_ta ON ${EQ('our_ta.alias_normalized', 'LOWER(TRIM(g.team_id))')}
     JOIN teams our_t ON our_t.id = our_ta.team_id
     JOIN team_aliases opp_ta ON ${EQ('opp_ta.alias_normalized', 'LOWER(TRIM(g.opponent))')}
     JOIN teams opp_t ON opp_t.id = opp_ta.team_id
     WHERE ${PLACEHOLDER}
       AND (g.is_home = 1 OR ${dedupNotExists})`);
  const [[{ gamesInserted }]] = await conn.query('SELECT COUNT(*) AS gamesInserted FROM games');
  gate('D1: games backfilled', d1.affectedRows > 0 && gamesInserted === d1.affectedRows,
    `inserted ${d1.affectedRows}, table now ${gamesInserted}`);

  // ── D2: parity vs alias-resolved distinct matchups ──
  const [[{ sourceMatchups }]] = await conn.query(
    `SELECT COUNT(DISTINCT CONCAT(
        LEAST(a_our.team_id, a_opp.team_id), '|',
        GREATEST(a_our.team_id, a_opp.team_id), '|',
        DATE(g.game_date))) AS sourceMatchups
     FROM team_schedules g
     JOIN team_aliases a_our ON ${EQ('a_our.alias_normalized', 'LOWER(TRIM(g.team_id))')}
     JOIN team_aliases a_opp ON ${EQ('a_opp.alias_normalized', 'LOWER(TRIM(g.opponent))')}
     WHERE ${PLACEHOLDER}`);
  gate('D2: game count parity (alias-resolved)', gamesInserted === sourceMatchups,
    `games=${gamesInserted}, distinct source matchups=${sourceMatchups}`);

  // ── D3: unresolved strings (should be impossible after C8.5) ──
  const [unOpp] = await conn.query(
    `SELECT g.opponent, COUNT(*) AS n FROM team_schedules g
     LEFT JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(g.opponent))')}
     WHERE ta.id IS NULL AND ${PLACEHOLDER} GROUP BY g.opponent`);
  const [unTeam] = await conn.query(
    `SELECT g.team_id, COUNT(*) AS n FROM team_schedules g
     LEFT JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(g.team_id))')}
     WHERE ta.id IS NULL GROUP BY g.team_id`);
  gate('D3: 0 unresolved opponents / team_ids', unOpp.length === 0 && unTeam.length === 0,
    `opponents: ${unOpp.length}, team_ids: ${unTeam.length}`);

  // ── D5: game_source_records ──
  await conn.query(
    `INSERT IGNORE INTO game_source_records (game_id, source, home_team_raw, away_team_raw, home_score, away_score, scraped_at)
     SELECT g.id, 'backfill', home_t.slug, away_t.slug, g.home_score, g.away_score, NOW()
     FROM games g
     JOIN teams home_t ON home_t.id = g.home_team_id
     JOIN teams away_t ON away_t.id = g.away_team_id
     WHERE g.canonical_source IS NULL`);
  const [[d5]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM games WHERE canonical_source IS NULL) AS backfilled,
            (SELECT COUNT(*) FROM game_source_records WHERE source = 'backfill') AS gsr`);
  gate('D5: one source record per backfilled game', d5.backfilled === d5.gsr, `games=${d5.backfilled}, gsr=${d5.gsr}`);

  // ── D6: team_seasons W-L refresh ──
  const [d6] = await conn.query(
    `UPDATE team_seasons ts
     LEFT JOIN v_team_season_record v ON v.team_id = ts.team_id AND v.season = ts.season
     SET ts.wins = COALESCE(v.wins, 0), ts.losses = COALESCE(v.losses, 0), ts.wl_computed_at = NOW()
     WHERE ts.season = 2026`);
  const [[{ notComputed }]] = await conn.query(
    `SELECT COUNT(*) AS notComputed FROM team_seasons ts JOIN teams t ON t.id = ts.team_id
     WHERE ts.season = 2026 AND t.state = 'OR' AND ts.wl_computed_at IS NULL`);
  gate('D6: W-L computed for all 41 OR teams', d6.affectedRows === 41 && notComputed === 0,
    `updated=${d6.affectedRows}, not computed=${notComputed}`);

  const [zeroZero] = await conn.query(
    `SELECT t.slug FROM team_seasons ts JOIN teams t ON t.id = ts.team_id
     WHERE ts.season = 2026 AND t.state = 'OR' AND ts.wins = 0 AND ts.losses = 0 ORDER BY t.slug`);
  report.push(`\n0-0 teams (verify vs OHSLA): ${zeroZero.length ? zeroZero.map(r => r.slug).join(', ') : 'none'}\n`);
  console.log('0-0 teams:', zeroZero.length ? zeroZero.map(r => r.slug).join(', ') : 'none');

  // GATE FIXED (2026-07-10): original assertion delta === oosWins wrongly assumed OR
  // teams never LOSE to out-of-state opponents. OR-vs-OR games net zero in the pool;
  // the correct identity is delta = (OR wins vs OOS) - (OR losses vs OOS).
  const [[parity]] = await conn.query(
    `SELECT SUM(wins) AS w, SUM(losses) AS l, SUM(wins) - SUM(losses) AS oos_delta FROM team_seasons WHERE season = 2026`);
  const [[oos]] = await conn.query(
    `SELECT
       SUM((ht.state = 'OR' AND at2.state != 'OR' AND g.home_score > g.away_score) OR
           (at2.state = 'OR' AND ht.state != 'OR' AND g.away_score > g.home_score)) AS oosWins,
       SUM((ht.state = 'OR' AND at2.state != 'OR' AND g.home_score < g.away_score) OR
           (at2.state = 'OR' AND ht.state != 'OR' AND g.away_score < g.home_score)) AS oosLosses
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at2 ON at2.id = g.away_team_id
     WHERE g.status = 'completed' AND ht.state != at2.state`);
  const oosWins = Number(oos.oosWins || 0), oosLosses = Number(oos.oosLosses || 0);
  gate('D6: W-L parity delta = OOS wins - OOS losses', Number(parity.oos_delta) === oosWins - oosLosses,
    `wins=${parity.w}, losses=${parity.l}, delta=${parity.oos_delta}, OOS record=${oosWins}-${oosLosses} (net ${oosWins - oosLosses})`);

  const [top10] = await conn.query(
    `SELECT t.slug, ts.wins, ts.losses FROM team_seasons ts JOIN teams t ON t.id = ts.team_id
     WHERE ts.season = 2026 AND t.state = 'OR' ORDER BY (ts.wins + ts.losses) DESC, t.slug LIMIT 10`);
  report.push('\nTop 10 by games played (cross-check vs OHSLA/LaxNumbers):\n\n' +
    top10.map(r => `- ${r.slug}: ${r.wins}-${r.losses}`).join('\n') + '\n');
  console.log('Top 10 W-L:', top10.map(r => `${r.slug} ${r.wins}-${r.losses}`).join(', '));

  // ── D7 pre-seed: laxpower truncation aliases ──
  // laxmath.com's LaxPower page truncates team names to 12 chars at the SOURCE
  // (scraper comment: '8 . Mountain Vie'). These strings are stable per-source
  // identifiers and will recur in every future scrape — permanent aliases, not a patch.
  const LAXPOWER_TRUNCATED = [
    ['Oregon Episc', 'oes'], ['Clackamas/Ne', 'nelson'], ['Jesuit Portl', 'jesuit'],
    ['Grant/Centra', 'grant'], ['Lake Oswego/', 'lake_oswego'], ['Mountain Vie', 'mt_view'],
    ['Central Cath', 'central_catholic'], ['Aloha/Southr', 'aloha_southridge'],
    ['Sprague/Sout', 'sprague'], ['West Salem/M', 'west_salem'],
  ];
  for (const [alias, slug] of LAXPOWER_TRUNCATED) {
    await conn.query(
      `INSERT IGNORE INTO team_aliases (team_id, alias, source)
       SELECT id, ?, 'laxpower-truncated' FROM teams WHERE slug = ?`, [alias, slug]);
  }

  // ── D7 (adapted): rankings backfill from laxnumbers_rankings + laxpower_rankings ──
  for (const [src, table, ratingCol] of [
    ['laxnumbers', 'laxnumbers_rankings', 'rating'],
    ['laxpower', 'laxpower_rankings', 'consensus'],
  ]) {
    await conn.query(
      `INSERT IGNORE INTO rankings_snapshots (source, season, captured_at, content_hash)
       SELECT ?, season, MAX(scraped_at), MD5(CONCAT_WS('|', ?, season, DATE(MAX(scraped_at))))
       FROM ${table} GROUP BY season`, [src, src]);
    await conn.query(
      `INSERT IGNORE INTO ranking_entries
         (snapshot_id, team_id, rank_position, rating, agd, sched, record_wins, record_losses)
       SELECT rs.id, ta.team_id, r.rank_position, CAST(r.${ratingCol} AS DECIMAL(8,2)),
              ${src === 'laxnumbers' ? 'CAST(r.agd AS DECIMAL(8,2)), CAST(r.sched AS DECIMAL(8,2))' : 'NULL, NULL'},
              r.wins, r.losses
       FROM ${table} r
       JOIN rankings_snapshots rs ON rs.source = ? AND rs.season = r.season
       JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(r.team_name))')}`, [src]);
    // GATE FIXED (2026-07-10): entries === srcRows can't tolerate legitimate source
    // duplicates (laxpower double-listed Westview at ranks 33/34). Correct invariant:
    // every DISTINCT resolved team has an entry, zero unresolved names. Source dupes
    // are absorbed by the (snapshot_id, team_id) PK — first-listed rank is kept,
    // preserving laxpower's published (phantom-inflated) rank positions as published.
    const [[{ srcRows }]] = await conn.query(`SELECT COUNT(*) AS srcRows FROM ${table}`);
    const [[{ distinctTeams }]] = await conn.query(
      `SELECT COUNT(DISTINCT ta.team_id) AS distinctTeams FROM ${table} r
       JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(r.team_name))')}`);
    const [[{ entries }]] = await conn.query(
      `SELECT COUNT(*) AS entries FROM ranking_entries re JOIN rankings_snapshots rs ON rs.id = re.snapshot_id WHERE rs.source = ?`, [src]);
    const [unNames] = await conn.query(
      `SELECT r.team_name, COUNT(*) AS n FROM ${table} r
       LEFT JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(r.team_name))')}
       WHERE ta.id IS NULL GROUP BY r.team_name`);
    const [srcDupes] = await conn.query(
      `SELECT t.slug, GROUP_CONCAT(r.rank_position ORDER BY r.rank_position) AS ranks, COUNT(*) AS n
       FROM ${table} r
       JOIN team_aliases ta ON ${EQ('ta.alias_normalized', 'LOWER(TRIM(r.team_name))')}
       JOIN teams t ON t.id = ta.team_id
       GROUP BY t.slug HAVING COUNT(*) > 1`);
    if (srcDupes.length) {
      const d = srcDupes.map(r => `${r.slug} @ ranks ${r.ranks}`).join('; ');
      console.log(`  note: ${src} source duplicates absorbed by PK: ${d}`);
      report.push(`  - note: ${src} source duplicates (kept first-listed rank): ${d}`);
    }
    gate(`D7: ${src} rankings backfilled`, entries === distinctTeams && unNames.length === 0,
      `source rows=${srcRows}, distinct teams=${distinctTeams}, entries=${entries}, unresolved=${unNames.length}${unNames.length ? ' (' + unNames.map(r => r.team_name).join(', ') + ')' : ''}`);
  }

  // ── D8: sign-off checks ──
  const [[{ orphanedGsr }]] = await conn.query(
    `SELECT COUNT(*) AS orphanedGsr FROM game_source_records gsr LEFT JOIN games g ON g.id = gsr.game_id WHERE g.id IS NULL`);
  gate('D8-2: 0 orphaned game_source_records', orphanedGsr === 0, `${orphanedGsr}`);
  const [[{ missingGsr }]] = await conn.query(
    `SELECT COUNT(*) AS missingGsr FROM games g LEFT JOIN game_source_records gsr ON gsr.game_id = g.id
     WHERE g.canonical_source IS NULL AND gsr.id IS NULL`);
  gate('D8-3: 0 backfilled games missing source record', missingGsr === 0, `${missingGsr}`);
  const [[{ nullTeams }]] = await conn.query(
    `SELECT COUNT(*) AS nullTeams FROM games WHERE home_team_id IS NULL OR away_team_id IS NULL`);
  gate('D8-5: 0 games with NULL team ids', nullTeams === 0, `${nullTeams}`);

  // status sanity: completed vs scheduled distribution
  const [statusDist] = await conn.query(`SELECT status, COUNT(*) AS n FROM games GROUP BY status`);
  report.push('\nGame status distribution: ' + statusDist.map(r => `${r.status}=${r.n}`).join(', ') + '\n');
  console.log('Status distribution:', statusDist.map(r => `${r.status}=${r.n}`).join(', '));

  const allGo = gates.every(g => g[1]);
  report.push(`\n## Sign-off log\n
DATE: ${new Date().toISOString().slice(0, 10)}
EXECUTOR: Spencer Welch (scripts prepared by Claude)
games rows: ${gamesInserted}
gsr rows: ${d5.gsr}
Scraper dupes: 0 (A10 verified)
OOS delta: ${parity.oos_delta}
Rankings skipped: NO (backfilled from laxnumbers_rankings + laxpower_rankings)
Placeholder rows excluded: 9 (logged in unresolved_aliases)
Section D: ${allGo ? 'APPROVED' : 'NOT APPROVED'}\n`);
  report.push(`\n## Section D: ${allGo ? '**GO — proceed to Section E**' : '**NO-GO — see failures above**'}\n`);
  console.log(`\nSection D overall: ${allGo ? 'GO' : 'NO-GO'}`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'section-d-report.md'), report.join('\n'));
  console.log('Report: db/migrate/out/section-d-report.md');
  await conn.end();
  if (!allGo) process.exit(1);
}

main().catch(e => {
  console.error('SECTION D FAILED:', e.message);
  report.push(`\n## CRASHED\n\n\`${e.message}\`\n`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'section-d-report.md'), report.join('\n'));
  process.exit(1);
});
