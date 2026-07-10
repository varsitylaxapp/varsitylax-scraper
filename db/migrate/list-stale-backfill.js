// List backfilled games never re-touched by the live scraper
// (canonical_source IS NULL). Run: node db/migrate/list-stale-backfill.js
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });
  const [rows] = await conn.query(
    `SELECT g.id, DATE_FORMAT(g.game_date, '%Y-%m-%d') AS date,
            ht.slug AS home, at2.slug AS away,
            g.home_score AS hs, g.away_score AS as2, g.status, g.is_conference AS conf
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at2 ON at2.id = g.away_team_id
     WHERE g.canonical_source IS NULL
     ORDER BY g.game_date`);
  console.table(rows);
  console.log(`${rows.length} backfill-only games (absent from current OHSLA feed).`);
  console.log('For each: check the matchup on ohsla.net — cancelled/removed = benign;');
  console.log('still listed on OHSLA = dedup key mismatch, investigate before E6.');
  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });
