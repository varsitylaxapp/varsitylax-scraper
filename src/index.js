require('dotenv').config();
const cron = require('node-cron');
const db   = require('./db');
const { scrapeLaxNumbers } = require('./scrapers/laxnumbers');
const { scrapeLaxPower }   = require('./scrapers/laxpower');
const { scrapeOHSLA }      = require('./scrapers/ohsla');

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

async function upsertOHSLA(games) {
  const sql = `
    INSERT INTO team_schedules
      (team_id, game_date, game_time, opponent, is_home, is_conference,
       result, team_score, opp_score, is_ot, season, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      game_time     = VALUES(game_time),
      is_home       = VALUES(is_home),
      is_conference = VALUES(is_conference),
      result        = VALUES(result),
      team_score    = VALUES(team_score),
      opp_score     = VALUES(opp_score),
      is_ot         = VALUES(is_ot),
      scraped_at    = VALUES(scraped_at)
  `;
  for (const g of games) {
    await db.execute(sql, [
      g.teamId, g.date, g.time, g.opponent,
      g.isHome, g.isConference,
      g.result, g.teamScore, g.oppScore, g.isOT,
      g.season, g.scrapedAt,
    ]);
  }
}

async function logScrape(source, count, status, errorMessage = null) {
  try {
    await db.execute(
      'INSERT INTO scrape_log (source, teams_scraped, status, error_message) VALUES (?, ?, ?, ?)',
      [source, count, status, errorMessage]
    );
  } catch (e) {
    console.error('[log] Failed to write scrape_log:', e.message);
  }
}

async function runAll() {
  console.log(`\n[${new Date().toISOString()}] Starting scrape run`);

  // ── LaxNumbers rankings ───────────────────────────────────────────────────
  try {
    const rankings = await scrapeLaxNumbers();
    await upsertLaxNumbers(rankings);
    await logScrape('laxnumbers', rankings.length, 'success');
    console.log(`[LaxNumbers] ✓ ${rankings.length} teams saved`);
  } catch (err) {
    console.error('[LaxNumbers] ✗', err.message);
    await logScrape('laxnumbers', 0, 'error', err.message);
  }

  // ── LaxPower rankings ─────────────────────────────────────────────────────
  try {
    const rankings = await scrapeLaxPower();
    await upsertLaxPower(rankings);
    await logScrape('laxpower', rankings.length, 'success');
    console.log(`[LaxPower] ✓ ${rankings.length} teams saved`);
  } catch (err) {
    console.error('[LaxPower] ✗', err.message);
    await logScrape('laxpower', 0, 'error', err.message);
  }

  // ── OHSLA schedules ───────────────────────────────────────────────────────
  try {
    const games = await scrapeOHSLA();
    await upsertOHSLA(games);
    await logScrape('ohsla', games.length, 'success');
    console.log(`[OHSLA] ✓ ${games.length} games saved`);
  } catch (err) {
    console.error('[OHSLA] ✗', err.message);
    await logScrape('ohsla', 0, 'error', err.message);
  }

  console.log('[done]\n');
}

const useCron = process.argv.includes('--cron');

if (useCron) {
  const month    = new Date().getMonth() + 1;
  const inSeason = month >= 3 && month <= 5;
  const schedule = inSeason ? '0 */2 * * *' : '0 6 * * *';
  console.log(`[cron] Schedule: "${schedule}" (${inSeason ? 'in-season' : 'off-season'})`);
  cron.schedule(schedule, runAll);
  runAll();
} else {
  runAll().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
