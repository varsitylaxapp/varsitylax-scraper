// Runbook E2/E3 monitor — run after each scraper cycle during the dual-write window.
// Appends a row to db/migrate/out/section-e-tracking.md each run (3 clean rows
// spanning >= 48h are required before E4).
// Usage (from varsitylax-scraper/):  node db/migrate/section-e-monitor.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const OUT = path.join(__dirname, 'out', 'section-e-tracking.md');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });
  const checks = [];
  const gate = (name, ok, detail) => {
    checks.push([name, ok, detail]);
    console.log(`${ok ? 'GO   ' : 'NO-GO'}  ${name} — ${detail}`);
  };

  // ── E2: both schemas receiving writes ──
  const [[snap]] = await conn.query(
    `SELECT source, season, captured_at FROM rankings_snapshots ORDER BY captured_at DESC LIMIT 1`);
  const [[v1Rank]] = await conn.query(
    `SELECT MAX(scraped_at) AS t FROM laxnumbers_rankings`);
  const [[newSched]] = await conn.query(
    `SELECT MAX(scraped_at) AS t, COUNT(*) AS today FROM game_source_records
     WHERE scraped_at >= CURDATE() AND source != 'backfill'`);
  const [[v1Sched]] = await conn.query(
    `SELECT MAX(scraped_at) AS t FROM team_schedules`);
  console.log(`\nLatest writes —`);
  console.log(`  rankings  v2: ${snap ? snap.captured_at + ' (' + snap.source + ')' : 'none'} | legacy: ${v1Rank.t}`);
  console.log(`  schedule  v2: ${newSched.t || 'none'} (${newSched.today} records today) | legacy: ${v1Sched.t}`);
  console.log(`  NOTE: v2 ranking snapshots are hash-deduped — an unchanged source correctly`);
  console.log(`  produces NO new snapshot. Off-season, check scrape_log *-v2 entries instead:`);
  const [v2Log] = await conn.query(
    `SELECT source, teams_scraped, status, error_message, scraped_at FROM scrape_log
     WHERE source LIKE '%-v2' ORDER BY scraped_at DESC LIMIT 6`);
  for (const r of v2Log) console.log(`    ${r.scraped_at} ${r.source}: ${r.status} (${r.teams_scraped})${r.error_message ? ' — ' + r.error_message : ''}`);
  const v2LogToday = v2Log.filter(r => new Date(r.scraped_at) >= new Date(new Date().toISOString().slice(0, 10)));
  gate('E2: v2 write path exercised today', v2LogToday.length > 0 && v2LogToday.every(r => r.status !== 'error'),
    `${v2LogToday.length} v2 log entries today, statuses: ${[...new Set(v2LogToday.map(r => r.status))].join(',') || 'n/a'}`);

  // ── E3 monitor 1: counts in sync ──
  const [[m1]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM games WHERE canonical_source IS NOT NULL) AS v2_sourced,
            (SELECT COUNT(*) FROM games) AS v2_total,
            (SELECT COUNT(DISTINCT team_id, opponent, game_date) FROM team_schedules) AS legacy_rows`);
  gate('E3-1: schema row counts recorded', true,
    `v2 sourced=${m1.v2_sourced}, v2 total=${m1.v2_total}, legacy perspective rows=${m1.legacy_rows}`);

  // ── E3 monitor 2: recent scraper output resolves ──
  const [recent] = await conn.query(
    `SELECT g.id, ht.slug AS home, at2.slug AS away, gsr.scraped_at
     FROM game_source_records gsr
     JOIN games g ON g.id = gsr.game_id
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at2 ON at2.id = g.away_team_id
     WHERE gsr.scraped_at >= NOW() - INTERVAL 26 HOUR AND gsr.source != 'backfill'
     ORDER BY gsr.scraped_at DESC LIMIT 20`);
  console.log(`  recent v2 game records (26h): ${recent.length}${recent.length ? ' — e.g. ' + recent.slice(0, 3).map(r => `${r.home} vs ${r.away}`).join(', ') : ''}`);

  // ── E3 monitor 2b: new unresolved aliases since migration ──
  const [newUnresolved] = await conn.query(
    `SELECT raw_name, source, occurrence_count, last_seen_at FROM unresolved_aliases
     WHERE raw_name != 'Team Place Holder' ORDER BY last_seen_at DESC`);
  gate('E3-2: no new unresolved aliases', newUnresolved.length === 0,
    newUnresolved.length ? newUnresolved.map(r => `'${r.raw_name}' (${r.source} x${r.occurrence_count})`).join(', ') : 'clean');

  // ── E3 monitor 3: canonical_source set on all live-scraped games ──
  const [[m3]] = await conn.query(
    `SELECT COUNT(*) AS n FROM games g
     JOIN game_source_records gsr ON gsr.game_id = g.id
     WHERE gsr.source != 'backfill' AND g.canonical_source IS NULL`);
  gate('E3-3: 0 live-scraped games missing canonical_source', m3.n === 0, `${m3.n}`);

  await conn.end();

  const allGo = checks.every(c => c[1]);
  console.log(`\nRun verdict: ${allGo ? 'CLEAN' : 'ISSUES — see above'}`);

  // Append tracking row
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) {
    fs.writeFileSync(OUT, `# Section E dual-write tracking log\n\nE2 activated at: (record on first dual run)\n\n| Timestamp (UTC) | v2 sourced games | v2 total | legacy rows | unresolved | verdict |\n|---|---|---|---|---|---|\n`);
  }
  fs.appendFileSync(OUT,
    `| ${new Date().toISOString()} | ${m1.v2_sourced} | ${m1.v2_total} | ${m1.legacy_rows} | ${newUnresolved.length} | ${allGo ? 'CLEAN' : 'ISSUES'} |\n`);
  console.log(`Tracking row appended: db/migrate/out/section-e-tracking.md`);
}

main().catch(e => { console.error('MONITOR FAILED:', e.message); process.exit(1); });
