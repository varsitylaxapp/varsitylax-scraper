// /api/v2 router — reads exclusively from the Phase 3 schema.
// Mounted in api.js: app.use('/api/v2', require('./api-v2'));
//
// v2 conventions: neutral game rows (home/away, not per-team perspective),
// rank_position (not `rank`), numeric fields as JSON numbers, team identity
// as { slug, name }.
const express = require('express');
const db = require('./db');

const router = express.Router();
const SEASON = () => parseInt(process.env.SEASON || '2026');
const num = v => (v === null || v === undefined ? null : parseFloat(v));

// ── helpers ──────────────────────────────────────────────────────────────────

async function latestSnapshot(source, season) {
  const [[snap]] = await db.execute(
    `SELECT id, captured_at FROM rankings_snapshots
     WHERE source = ? AND season = ? ORDER BY captured_at DESC LIMIT 1`, [source, season]);
  if (!snap) return null;
  const [rows] = await db.execute(
    `SELECT re.rank_position, t.slug, t.name AS teamName,
            re.rating, re.agd, re.sched, re.record_wins AS wins, re.record_losses AS losses
     FROM ranking_entries re
     JOIN teams t ON t.id = re.team_id
     WHERE re.snapshot_id = ?
     ORDER BY re.rank_position`, [snap.id]);
  return {
    capturedAt: snap.captured_at,
    rankings: rows.map(r => ({
      rank_position: r.rank_position, slug: r.slug, teamName: r.teamName,
      wins: r.wins, losses: r.losses,
      record: r.wins !== null && r.losses !== null ? `${r.wins}-${r.losses}` : null,
      rating: num(r.rating), agd: num(r.agd), sched: num(r.sched),
    })),
  };
}

const GAME_SELECT = `
  SELECT g.id, g.season, g.game_date AS date, g.game_datetime AS datetime,
         g.status, g.is_conference AS isConference, g.is_overtime AS isOvertime,
         g.home_score AS homeScore, g.away_score AS awayScore,
         ht.slug AS homeSlug, ht.name AS homeName, ht.state AS homeState,
         at2.slug AS awaySlug, at2.name AS awayName, at2.state AS awayState,
         v.name AS venueName, v.city AS venueCity
  FROM games g
  JOIN teams ht  ON ht.id  = g.home_team_id
  JOIN teams at2 ON at2.id = g.away_team_id
  LEFT JOIN venues v ON v.id = g.venue_id`;

function gameJson(r) {
  return {
    id: r.id, season: r.season, date: r.date, datetime: r.datetime, status: r.status,
    isConference: !!r.isConference, isOvertime: !!r.isOvertime,
    home: { slug: r.homeSlug, name: r.homeName, state: r.homeState, score: r.homeScore },
    away: { slug: r.awaySlug, name: r.awayName, state: r.awayState, score: r.awayScore },
    venue: r.venueName ? { name: r.venueName, city: r.venueCity } : null,
  };
}

// ── GET /api/v2/health ───────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const [[gsr]] = await db.execute(
      `SELECT MAX(scraped_at) AS lastGameWrite FROM game_source_records WHERE source != 'backfill'`);
    const [[snap]] = await db.execute(
      `SELECT MAX(captured_at) AS lastSnapshot FROM rankings_snapshots`);
    res.json({ status: 'ok', schema: 'v2', lastGameWrite: gsr.lastGameWrite, lastSnapshot: snap.lastSnapshot });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ── GET /api/v2/rankings/laxnumbers | laxpower ──────────────────────────────
router.get('/rankings/laxnumbers', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  try {
    const snap = await latestSnapshot('laxnumbers', season);
    if (!snap) return res.status(404).json({ error: `no laxnumbers snapshot for season ${season}` });
    res.json({ source: 'laxnumbers', season, updated: snap.capturedAt, rankings: snap.rankings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rankings/laxpower', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  try {
    const snap = await latestSnapshot('laxpower', season);
    if (!snap) return res.status(404).json({ error: `no laxpower snapshot for season ${season}` });
    // laxpower's metric is consensus — stored in rating, surfaced under both names
    const rankings = snap.rankings.map(({ agd, sched, ...r }) => ({ ...r, consensus: r.rating }));
    res.json({ source: 'laxpower', season, updated: snap.capturedAt, rankings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rankings/both', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  try {
    const [ln, lp] = await Promise.all([
      latestSnapshot('laxnumbers', season), latestSnapshot('laxpower', season)]);
    res.json({
      season,
      laxnumbers: ln ? { updated: ln.capturedAt, rankings: ln.rankings } : null,
      laxpower: lp ? {
        updated: lp.capturedAt,
        rankings: lp.rankings.map(({ agd, sched, ...r }) => ({ ...r, consensus: r.rating })),
      } : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/v2/teams ────────────────────────────────────────────────────────
router.get('/teams', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  try {
    const [rows] = await db.execute(
      `SELECT t.slug, t.name, t.mascot, t.city, t.state,
              ts.conference, ts.wins, ts.losses,
              v.name AS venueName, v.city AS venueCity
       FROM teams t
       LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season = ?
       LEFT JOIN venues v ON v.id = t.home_venue_id
       WHERE t.state = 'OR'
       ORDER BY t.name`, [season]);
    res.json({
      season,
      teams: rows.map(r => ({
        slug: r.slug, name: r.name, mascot: r.mascot, city: r.city, state: r.state,
        conference: r.conference, wins: r.wins, losses: r.losses,
        record: r.wins !== null ? `${r.wins}-${r.losses}` : null,
        venue: r.venueName ? { name: r.venueName, city: r.venueCity } : null,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/v2/schedule/all ─────────────────────────────────────────────────
router.get('/schedule/all', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  try {
    const [rows] = await db.execute(
      `${GAME_SELECT} WHERE g.season = ? ORDER BY g.game_date, g.id`, [season]);
    res.json({ season, games: rows.map(gameJson) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/v2/schedule/playoffs ────────────────────────────────────────────
// Playoff window start is config-driven (season-agnostic goal); falls back to
// the 2026 value the v1 endpoint hardcodes.
router.get('/schedule/playoffs', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  const start = process.env.PLAYOFFS_START || `${season}-05-14`;
  try {
    const [rows] = await db.execute(
      `${GAME_SELECT} WHERE g.season = ? AND g.game_date >= ? ORDER BY g.game_date, g.id`,
      [season, start]);
    res.json({ season, playoffsStart: start, games: rows.map(gameJson) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/v2/schedule/team/:slug ──────────────────────────────────────────
// Per-team perspective derived from neutral rows (shape the iOS team page wants).
router.get('/schedule/team/:slug', async (req, res) => {
  const season = parseInt(req.query.season || SEASON());
  const { slug } = req.params;
  try {
    const [[team]] = await db.execute(`SELECT id, slug, name FROM teams WHERE slug = ?`, [slug]);
    if (!team) return res.status(404).json({ error: `unknown team slug '${slug}'` });
    const [rows] = await db.execute(
      `${GAME_SELECT} WHERE g.season = ? AND (g.home_team_id = ? OR g.away_team_id = ?)
       ORDER BY g.game_date, g.id`, [season, team.id, team.id]);
    const games = rows.map(r => {
      const isHome = r.homeSlug === slug;
      const teamScore = isHome ? r.homeScore : r.awayScore;
      const oppScore = isHome ? r.awayScore : r.homeScore;
      return {
        id: r.id, date: r.date, datetime: r.datetime, status: r.status,
        isHome, isConference: !!r.isConference, isOvertime: !!r.isOvertime,
        opponent: { slug: isHome ? r.awaySlug : r.homeSlug, name: isHome ? r.awayName : r.homeName,
                    state: isHome ? r.awayState : r.homeState },
        teamScore, oppScore,
        result: r.status === 'completed' ? (teamScore > oppScore ? 'W' : teamScore < oppScore ? 'L' : 'T') : null,
        venue: r.venueName ? { name: r.venueName, city: r.venueCity } : null,
      };
    });
    res.json({ team: { slug: team.slug, name: team.name }, season, games });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
