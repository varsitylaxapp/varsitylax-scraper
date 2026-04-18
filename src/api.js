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
    res.json({ source: 'laxnumbers', season, updated, rankings: rows });
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
    res.json({ source: 'laxpower', season, updated, rankings: rows });
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
      laxnumbers: { updated: lnRows[0]?.scrapedAt || null, rankings: lnRows },
      laxpower:   { updated: lpRows[0]?.scrapedAt || null, rankings: lpRows },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VarsityLax API running on port ${PORT}`);
});

module.exports = app;
