// E7 sign-off checks (runbook-section-e.md E7), adapted to actual legacy table names:
// rankings_v1 -> laxnumbers_rankings, games_v1 -> team_schedules
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });

  // Check 1: new schema is the sole write target (live records today)
  const [[c1]] = await conn.query(
    `SELECT COUNT(*) AS n FROM game_source_records
     WHERE scraped_at >= CURDATE() AND source != 'backfill'`);
  console.log(`Check 1 — live_source_records_today: ${c1.n}  ${c1.n > 0 ? 'GO' : 'NO-GO (expected > 0)'}`);

  // Check 2: no unresolved aliases in recent output
  const [[c2]] = await conn.query(
    `SELECT COUNT(*) AS n FROM games g
     JOIN game_source_records gsr ON gsr.game_id = g.id
     WHERE gsr.scraped_at >= CURDATE() AND gsr.source != 'backfill'
       AND g.canonical_source IS NULL`);
  console.log(`Check 2 — missing_canonical_today: ${c2.n}  ${c2.n === 0 ? 'GO' : 'NO-GO (expected 0)'}`);

  // Check 4: legacy tables frozen (> 24h)
  const [[c4]] = await conn.query(
    `SELECT (SELECT MAX(scraped_at) FROM laxnumbers_rankings) AS last_v1_rankings_write,
            (SELECT MAX(scraped_at) FROM team_schedules)      AS last_v1_schedule_write,
            NOW() AS now`);
  const hrs = t => t ? ((new Date(c4.now) - new Date(t)) / 36e5).toFixed(1) : 'n/a';
  console.log(`Check 4 — last_v1_rankings_write: ${c4.last_v1_rankings_write} (${hrs(c4.last_v1_rankings_write)}h ago)`);
  console.log(`Check 4 — last_v1_schedule_write: ${c4.last_v1_schedule_write} (${hrs(c4.last_v1_schedule_write)}h ago)`);
  console.log(`Check 4 — DB NOW(): ${c4.now}`);
  const ok4 = [c4.last_v1_rankings_write, c4.last_v1_schedule_write].every(t => (new Date(c4.now) - new Date(t)) > 24 * 36e5);
  console.log(`Check 4 — ${ok4 ? 'GO (both frozen > 24h)' : 'NO-GO'}`);

  // Supporting: today's scrape_log v2 entries
  const [logs] = await conn.query(
    `SELECT source, status, teams_scraped, scraped_at FROM scrape_log
     WHERE scraped_at >= CURDATE() ORDER BY scraped_at DESC LIMIT 10`);
  console.log('\nscrape_log today:');
  logs.forEach(l => console.log(`  ${l.scraped_at instanceof Date ? l.scraped_at.toISOString() : l.scraped_at}  ${l.source}  ${l.status}  teams=${l.teams_scraped}`));

  await conn.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
