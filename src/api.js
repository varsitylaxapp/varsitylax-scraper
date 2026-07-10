require('dotenv').config();
const express = require('express');
const db      = require('./db');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(express.json());

// ─── /api/v2 — Phase 3 schema (runbook E1) ──────────────────────────────────
app.use('/api/v2', require('./api-v2'));

// ─── v1 deprecation headers (runbook E4 / E5.5 — env-gated, no redeploy) ────
// E4:   set V1_DEPRECATION_WARNING=true   (Warning: 299 only)
// E5.5: set V1_SUNSET_DATE="Thu, 08 Oct 2026 00:00:00 GMT" (adds Sunset header)
// Scoped to v1 only: /api/v2 is mounted above, so this middleware never sees it.
app.use('/api', (req, res, next) => {
  if (process.env.V1_DEPRECATION_WARNING === 'true') {
    const sunset = process.env.V1_SUNSET_DATE;
    if (sunset) {
      res.set('Sunset', sunset);
      res.set('Warning', `299 - "This endpoint is deprecated. Migrate to /api/v2/. Sunset: ${sunset}."`);
    } else {
      res.set('Warning', '299 - "This endpoint is deprecated. Migrate to /api/v2/. A Sunset date will be added after client migration is confirmed complete."');
    }
  }
  next();
});

// ─── GET /health ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT scraped_at FROM scrape_log WHERE status = ? ORDER BY scraped_at DESC LIMIT 1',
      ['success']
    );
    res.json({ status: 'ok', lastScrape: rows[0]?.scraped_at || null });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── GET /api/rankings/laxnumbers ────────────────────────────────────────────

app.get('/api/rankings/laxnumbers', async (req, res) => {
  const season = parseInt(req.query.season || process.env.SEASON || '2026');
  try {
    const [rows] = await db.execute(
      `SELECT rank_position AS \`rank\`, team_name AS teamName, record, wins, losses,
              rating, agd, sched, scraped_at AS scrapedAt
       FROM laxnumbers_rankings
       WHERE season = ?
       ORDER BY rank_position`,
      [season]
    );
    const updated = rows[0]?.scrapedAt || null;
    const rankings = rows.map(r => ({
      ...r,
      rating: parseFloat(r.rating),
      agd:    parseFloat(r.agd),
      sched:  parseFloat(r.sched),
    }));
    res.json({ source: 'laxnumbers', season, updated, rankings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/rankings/laxpower ──────────────────────────────────────────────

app.get('/api/rankings/laxpower', async (req, res) => {
  const season = parseInt(req.query.season || process.env.SEASON || '2026');
  try {
    const [rows] = await db.execute(
      `SELECT rank_position AS \`rank\`, team_name AS teamName, record, wins, losses,
              consensus, scraped_at AS scrapedAt
       FROM laxpower_rankings
       WHERE season = ?
       ORDER BY rank_position`,
      [season]
    );
    const updated = rows[0]?.scrapedAt || null;
    const rankings = rows.map(r => ({ ...r, consensus: parseFloat(r.consensus) }));
    res.json({ source: 'laxpower', season, updated, rankings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/rankings/both ──────────────────────────────────────────────────

app.get('/api/rankings/both', async (req, res) => {
  const season = parseInt(req.query.season || process.env.SEASON || '2026');
  try {
    const [[lnRows], [lpRows]] = await Promise.all([
      db.execute(
        `SELECT rank_position AS \`rank\`, team_name AS teamName, record, wins, losses,
                rating, agd, sched, scraped_at AS scrapedAt
         FROM laxnumbers_rankings WHERE season = ? ORDER BY rank_position`,
        [season]
      ),
      db.execute(
        `SELECT rank_position AS \`rank\`, team_name AS teamName, record, wins, losses,
                consensus, scraped_at AS scrapedAt
         FROM laxpower_rankings WHERE season = ? ORDER BY rank_position`,
        [season]
      ),
    ]);

    res.json({
      season,
      laxnumbers: {
        updated:  lnRows[0]?.scrapedAt || null,
        rankings: lnRows.map(r => ({ ...r, rating: parseFloat(r.rating), agd: parseFloat(r.agd), sched: parseFloat(r.sched) })),
      },
      laxpower: {
        updated:  lpRows[0]?.scrapedAt || null,
        rankings: lpRows.map(r => ({ ...r, consensus: parseFloat(r.consensus) })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/schedule/all ───────────────────────────────────────────────────
// Must be defined BEFORE /:teamId so Express doesn't treat "all" as a teamId.

app.get('/api/schedule/all', async (req, res) => {
  const season = parseInt(req.query.season || process.env.SEASON || '2026');
  try {
    const [rows] = await db.execute(
      `SELECT team_id        AS teamId,
              game_date      AS date,
              game_time      AS time,
              opponent,
              is_home        AS isHome,
              is_conference  AS isConference,
              result,
              team_score     AS teamScore,
              opp_score      AS oppScore,
              is_ot          AS isOT
       FROM team_schedules
       WHERE season = ?
       ORDER BY game_date, game_time`,
      [season]
    );
    res.json({ season, games: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/schedule/playoffs ─────────────────────────────────────────────
// Returns one row per unique playoff game (home team's perspective).
// Must be defined BEFORE /:teamId so Express doesn't treat "playoffs" as a teamId.

app.get('/api/schedule/playoffs', async (req, res) => {
  try {
    const season = parseInt(req.query.season || process.env.SEASON || '2026');
    const startDate = '2026-05-14';

    const [rows] = await db.execute(
      `SELECT id, team_id AS home_team_id, opponent AS away_team,
              game_date, game_time, team_score AS home_score,
              opp_score AS away_score, scraped_at
       FROM team_schedules
       WHERE game_date >= ?
         AND opponent != 'Team Place Holder'
         AND is_home = 1
         AND season = ?
       ORDER BY game_date, game_time`,
      [startDate, season]
    );

    const games = rows.map(r => ({
      ...r,
      home_score: r.home_score !== null ? parseInt(r.home_score, 10) : null,
      away_score: r.away_score !== null ? parseInt(r.away_score, 10) : null,
    }));

    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/schedule/:teamId ────────────────────────────────────────────────

app.get('/api/schedule/:teamId', async (req, res) => {
  const { teamId } = req.params;
  const season = parseInt(req.query.season || process.env.SEASON || '2026');
  try {
    const [rows] = await db.execute(
      `SELECT game_date      AS date,
              game_time      AS time,
              opponent,
              is_home        AS isHome,
              is_conference  AS isConference,
              result,
              team_score     AS teamScore,
              opp_score      AS oppScore,
              is_ot          AS isOT
       FROM team_schedules
       WHERE team_id = ? AND season = ?
       ORDER BY game_date, game_time`,
      [teamId, season]
    );
    res.json({ teamId, season, games: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VarsityLax API running on port ${PORT}`);
});

module.exports = app;
