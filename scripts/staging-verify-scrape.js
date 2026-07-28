#!/usr/bin/env node
// Railway ONE-OFF (no schedule). Runs the Oregon scrape end-to-end against
// STAGING, then asserts nothing unexpected was written.
//
// SAFETY: requires DB_TARGET=staging (or --target=staging). src/db.js refuses to
// start if STAGING_DATABASE_URL is absent or resolves to the same host as
// DB_HOST, and prints its resolved target on boot. This script additionally
// refuses to run unless that target is STAGING.
//
// Checks:
//   1. no new rows anywhere except scrape_log (which is append-only telemetry)
//   2. no duplicate games — same (season, home, away, date) AND no mirrored pair
//   3. rankings content hash unchanged (offseason: rankings are static, so the
//      snapshot dedup must skip and NOT insert a new snapshot)
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const db = require('../src/db');

const TABLES = [
  'teams', 'team_aliases', 'team_seasons', 'divisions', 'games',
  'game_source_records', 'rankings_snapshots', 'ranking_entries', 'venues',
  'unresolved_aliases', 'scrape_log', 'team_schedules',
  'laxnumbers_rankings', 'laxpower_rankings', 'coaches', 'team_coaches',
];

async function counts() {
  const out = {};
  for (const t of TABLES) {
    const [[r]] = await db.execute(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = r.n;
  }
  return out;
}

async function snapshotHashes() {
  const [rows] = await db.execute(
    `SELECT id, source, state, season, captured_at, content_hash
     FROM rankings_snapshots ORDER BY id`);
  return rows;
}

function runScrape() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'src', 'index.js'), '--target=staging'],
      { env: { ...process.env, DB_TARGET: 'staging' }, stdio: 'inherit' }
    );
    child.on('exit', code => resolve(code));
  });
}

(async () => {
  if (db.targetLabel !== 'staging') {
    console.error(`FATAL: resolved target is "${db.targetLabel}", refusing to run. ` +
                  'This job only ever runs against staging.');
    process.exit(1);
  }
  console.log(`\n=== staging-verify-scrape ===`);
  console.log(`target: ${db.targetDescription}`);
  console.log(`WRITE_MODE=${process.env.WRITE_MODE || 'legacy'}  SEASON=${process.env.SEASON}\n`);

  const [[{ maxLogId }]] = await db.execute('SELECT COALESCE(MAX(id),0) AS maxLogId FROM scrape_log');
  const [[{ wlBefore }]] = await db.execute(
    'SELECT COALESCE(MAX(wl_computed_at), \'1970-01-01\') AS wlBefore FROM team_seasons');
  const before = await counts();
  const hashBefore = await snapshotHashes();
  console.log('--- row counts BEFORE ---');
  for (const [t, n] of Object.entries(before)) console.log(`  ${t.padEnd(22)} ${n}`);

  console.log('\n--- running src/index.js (full OR scrape) ---');
  const code = await runScrape();
  console.log(`--- scrape exited ${code} ---\n`);

  const after = await counts();
  const hashAfter = await snapshotHashes();

  console.log('--- row counts AFTER (delta) ---');
  const deltas = {};
  for (const t of TABLES) {
    const d = after[t] - before[t];
    deltas[t] = d;
    console.log(`  ${t.padEnd(22)} ${String(after[t]).padEnd(8)} ${d === 0 ? '=' : (d > 0 ? '+' + d : d)}`);
  }

  const results = [];

  // CHECK 1 — only scrape_log may grow.
  const unexpected = TABLES.filter(t => t !== 'scrape_log' && deltas[t] !== 0);
  results.push([
    'no new rows outside scrape_log',
    unexpected.length === 0,
    unexpected.length ? unexpected.map(t => `${t}${deltas[t] > 0 ? '+' : ''}${deltas[t]}`).join(', ') : 'all deltas zero',
  ]);
  results.push([
    'scrape_log grew (scrape actually ran)',
    deltas.scrape_log > 0,
    `+${deltas.scrape_log} rows`,
  ]);

  // CHECK 1b — THE important one. Row counts alone let a source fail silently:
  // the 2026-07-27 run passed all checks while OHSLA errored on a view definer.
  // Assert status, never just counts.
  const [logRows] = await db.execute(
    'SELECT source, state, status, error_message FROM scrape_log WHERE id > ?', [maxLogId]);
  const failed = logRows.filter(r => r.status !== 'success');
  results.push([
    'every scrape_log row written this run is success',
    logRows.length > 0 && failed.length === 0,
    failed.length ? failed.map(r => `${r.source}/${r.state}: ${r.error_message}`).join(' | ')
                  : `${logRows.length} rows, all success`,
  ]);

  // CHECK 1c — refreshWinLoss() must actually complete. It reads
  // v_team_season_record, which is what the definer bug broke; W-L silently
  // stopped being recomputed while every count check still passed.
  const [[{ wlAfter }]] = await db.execute(
    'SELECT COALESCE(MAX(wl_computed_at), \'1970-01-01\') AS wlAfter FROM team_seasons');
  const [[{ nullWl }]] = await db.execute(
    'SELECT COUNT(*) AS nullWl FROM team_seasons WHERE season = 2026 AND wl_computed_at IS NULL');
  results.push([
    'refreshWinLoss completed (team_seasons W-L recomputed)',
    new Date(wlAfter) > new Date(wlBefore) && nullWl === 0,
    `wl_computed_at ${wlBefore} -> ${wlAfter}, ${nullWl} rows still NULL`,
  ]);

  // CHECK 2 — duplicate games, both exact and mirrored orientation.
  const [dupExact] = await db.execute(
    `SELECT season, home_team_id, away_team_id, game_date, COUNT(*) n
     FROM games GROUP BY season, home_team_id, away_team_id, game_date HAVING n > 1`);
  const [dupMirror] = await db.execute(
    `SELECT LEAST(home_team_id, away_team_id) a, GREATEST(home_team_id, away_team_id) b,
            game_date, COUNT(*) n
     FROM games GROUP BY a, b, game_date HAVING n > 1`);
  results.push(['no exact duplicate games', dupExact.length === 0, `${dupExact.length} groups`]);
  results.push(['no mirrored duplicate games', dupMirror.length === 0,
    dupMirror.length ? JSON.stringify(dupMirror.slice(0, 5)) : '0 groups']);

  // CHECK 3 — offseason: rankings static, so no new snapshot should be inserted.
  const newSnaps = hashAfter.filter(a => !hashBefore.some(b => b.id === a.id));
  results.push([
    'rankings content-hash unchanged (no new snapshot)',
    newSnaps.length === 0,
    newSnaps.length ? `NEW: ${JSON.stringify(newSnaps.map(s => ({ src: s.source, st: s.state, h: String(s.content_hash).slice(0, 12) })))}`
                    : `${hashAfter.length} snapshots, all pre-existing`,
  ]);

  // CHECK 4 — every snapshot and alias carries a state (Section F invariants).
  const [[{ n: badSnap }]] = await db.execute(
    `SELECT COUNT(*) n FROM rankings_snapshots WHERE state IS NULL OR state = ''`);
  const [[{ n: drift }]] = await db.execute(
    `SELECT COUNT(*) n FROM team_aliases ta JOIN teams t ON t.id = ta.team_id WHERE ta.state <> t.state`);
  results.push(['all snapshots have a state', badSnap === 0, `${badSnap} bad`]);
  results.push(['team_aliases.state has no drift', drift === 0, `${drift} drifted`]);

  console.log('\n--- CHECKS ---');
  let allPass = true;
  for (const [name, ok, detail] of results) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (!ok) allPass = false;
  }
  console.log(`\n=== ${allPass ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} ===\n`);
  await db.end();
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
