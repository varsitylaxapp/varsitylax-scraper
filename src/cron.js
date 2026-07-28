// Railway cron entry point — runs once and exits.
// Railway fires this on the configured schedule.
require('dotenv').config();
const db = require('./db');
const { scrapeLaxNumbers } = require('./scrapers/laxnumbers');
const { scrapeLaxPower }   = require('./scrapers/laxpower');
const { enabledStates, DEFAULT_STATE } = require('./config/states');

const SEASON = parseInt(process.env.SEASON || '2026');

async function upsertLaxNumbers(rankings) {
  const sql = `
    INSERT INTO laxnumbers_rankings
      (season, rank_position, team_name, record, wins, losses, rating, agd, sched, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      team_name = VALUES(team_name), record = VALUES(record),
      wins = VALUES(wins), losses = VALUES(losses), rating = VALUES(rating),
      agd = VALUES(agd), sched = VALUES(sched), scraped_at = VALUES(scraped_at)
  `;
  for (const r of rankings) {
    await db.execute(sql, [r.season, r.rank, r.teamName, r.record, r.wins, r.losses, r.rating, r.agd, r.sched, r.scrapedAt]);
  }
}

async function upsertLaxPower(rankings) {
  const sql = `
    INSERT INTO laxpower_rankings
      (season, rank_position, team_name, record, wins, losses, consensus, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      team_name = VALUES(team_name), record = VALUES(record),
      wins = VALUES(wins), losses = VALUES(losses), consensus = VALUES(consensus),
      scraped_at = VALUES(scraped_at)
  `;
  for (const r of rankings) {
    await db.execute(sql, [r.season, r.rank, r.teamName, r.record, r.wins, r.losses, r.consensus, r.scrapedAt]);
  }
}

async function logScrape(source, count, status, errorMessage = null, state = DEFAULT_STATE) {
  try {
    await db.execute(
      'INSERT INTO scrape_log (source, state, teams_scraped, status, error_message) VALUES (?, ?, ?, ?, ?)',
      [source, state, count, status, errorMessage]
    );
  } catch (e) {
    console.error('[log]', e.message);
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Cron scrape starting`);

  // NOTE: cron.js deliberately does NOT call dual-write (decision 7 = defer).
  // Adding a v2 write here would create rows, which contradicts the
  // "no new/duplicate rows" gate for Phase F.
  for (const st of enabledStates('hasRankings')) {
    try {
      const rankings = await scrapeLaxNumbers(st);
      if (st.code === DEFAULT_STATE) {
        await upsertLaxNumbers(rankings);
        await logScrape('laxnumbers', rankings.length, 'success', null, st.code);
        console.log(`[LaxNumbers] ✓ ${rankings.length} teams`);
      }
    } catch (err) {
      console.error(`[LaxNumbers:${st.code}] ✗`, err.message);
      await logScrape('laxnumbers', 0, 'error', err.message, st.code);
    }
  }

  try {
    const rankings = await scrapeLaxPower();
    await upsertLaxPower(rankings);
    await logScrape('laxpower', rankings.length, 'success');
    console.log(`[LaxPower] ✓ ${rankings.length} teams`);
  } catch (err) {
    console.error('[LaxPower] ✗', err.message);
    await logScrape('laxpower', 0, 'error', err.message);
  }

  console.log(`[${new Date().toISOString()}] Done`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
