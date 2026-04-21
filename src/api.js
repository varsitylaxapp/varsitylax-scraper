require('dotenv').config();
const express = require('express');
const db      = require('./db');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(express.json());

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
