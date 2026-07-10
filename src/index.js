require('dotenv').config();
const cron = require('node-cron');
const db   = require('./db');
const { scrapeLaxNumbers } = require('./scrapers/laxnumbers');
const { scrapeLaxPower }   = require('./scrapers/laxpower');
const { scrapeOHSLA }      = require('./scrapers/ohsla');
const dualWrite            = require('./dual-write');

const SEASON = parseInt(process.env.SEASON || '2026');

// WRITE_MODE (runbook E2/E6): 'legacy' (default) | 'dual' | 'v2'
const WRITE_MODE  = process.env.WRITE_MODE || 'legacy';
const writeLegacy = WRITE_MODE !== 'v2';
const writeV2     = WRITE_MODE !== 'legacy';

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
  console.log(`\n[${new Date().toISOString()}] Starting scrape run (WRITE_MODE=${WRITE_MODE})`);

  // ── LaxNumbers rankings ───────────────────────────────────────────────────
  try {
    const rankings = await scrapeLaxNumbers();
    if (writeLegacy) {
      await upsertLaxNumbers(rankings);
      await logScrape('laxnumbers', rankings.length, 'success');
      console.log(`[LaxNumbers] ✓ ${rankings.length} teams saved (legacy)`);
    }
    if (writeV2) {
      const r = await dualWrite.writeRankings('laxnumbers', rankings);
      await logScrape('laxnumbers-v2', rankings.length, r.unresolved.length ? 'partial' : 'success',
        r.unresolved.length ? `unresolved: ${r.unresolved.join(', ')}` : null);
      console.log(`[LaxNumbers] ✓ v2: ${r.snapshotId ? r.entries + ' entries, snapshot ' + r.snapshotId : 'unchanged, snapshot skipped'}${r.unresolved.length ? ' — UNRESOLVED: ' + r.unresolved.join(', ') : ''}`);
    }
  } catch (err) {
    console.error('[LaxNumbers] ✗', err.message);
    await logScrape('laxnumbers', 0, 'error', err.message);
  }

  // ── LaxPower rankings ─────────────────────────────────────────────────────
  try {
    const rankings = await scrapeLaxPower();
    if (writeLegacy) {
      await upsertLaxPower(rankings);
      await logScrape('laxpower', rankings.length, 'success');
      console.log(`[LaxPower] ✓ ${rankings.length} teams saved (legacy)`);
    }
    if (writeV2) {
      const r = await dualWrite.writeRankings('laxpower', rankings);
      await logScrape('laxpower-v2', rankings.length, r.unresolved.length ? 'partial' : 'success',
        r.unresolved.length ? `unresolved: ${r.unresolved.join(', ')}` : null);
      console.log(`[LaxPower] ✓ v2: ${r.snapshotId ? r.entries + ' entries, snapshot ' + r.snapshotId : 'unchanged, snapshot skipped'}${r.unresolved.length ? ' — UNRESOLVED: ' + r.unresolved.join(', ') : ''}`);
    }
  } catch (err) {
    console.error('[LaxPower] ✗', err.message);
    await logScrape('laxpower', 0, 'error', err.message);
  }

  // ── OHSLA schedules ───────────────────────────────────────────────────────
  try {
    const games = await scrapeOHSLA();
    if (writeLegacy) {
      await upsertOHSLA(games);
      await logScrape('ohsla', games.length, 'success');
      console.log(`[OHSLA] ✓ ${games.length} games saved (legacy)`);
    }
    if (writeV2) {
      const r = await dualWrite.writeGames(games, 'ohsla');
      await logScrape('ohsla-v2', r.written, r.unresolved.length ? 'partial' : 'success',
        r.unresolved.length ? `unresolved: ${r.unresolved.join(', ')}` : null);
      console.log(`[OHSLA] ✓ v2: ${r.written} matchups upserted${r.unresolved.length ? ` — UNRESOLVED (${r.skipped}): ` + r.unresolved.join(', ') : ''}`);
    }
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
