require('dotenv').config();
const db = require('./db');

const SEASON = parseInt(process.env.SEASON || new Date().getFullYear());
const PASSES  = 15;
const MAX_GOAL_DIFF = 10; // cap per game

async function computeRatings(season = SEASON) {
  console.log(`Computing ratings for season ${season}…`);

  // 1. Get all completed, non-scrimmage games
  const games = await db.getCompletedGames(season);
  if (games.length === 0) {
    console.log('  No completed games found — skipping ratings.');
    return;
  }

  // 2. Collect all team IDs that appear in completed games
  const teamIds = new Set();
  for (const g of games) {
    teamIds.add(g.home_team_id);
    teamIds.add(g.away_team_id);
  }

  // Build per-team stats: wins, losses, list of goal diffs, list of opponent IDs
  const stats = {};
  for (const id of teamIds) {
    stats[id] = { wins: 0, losses: 0, goalDiffs: [], opponents: [] };
  }

  for (const g of games) {
    const diff = Math.min(Math.abs(g.home_score - g.away_score), MAX_GOAL_DIFF);
    const homeWon = g.home_score > g.away_score;

    stats[g.home_team_id].goalDiffs.push(diff);
    stats[g.home_team_id].opponents.push(g.away_team_id);
    if (homeWon) stats[g.home_team_id].wins++;
    else         stats[g.home_team_id].losses++;

    stats[g.away_team_id].goalDiffs.push(diff);
    stats[g.away_team_id].opponents.push(g.home_team_id);
    if (!homeWon) stats[g.away_team_id].wins++;
    else          stats[g.away_team_id].losses++;
  }

  // 3. Compute initial AGD for each team
  const agd = {};
  for (const id of teamIds) {
    const s = stats[id];
    const gp = s.goalDiffs.length;
    agd[id] = gp > 0
      ? s.goalDiffs.reduce((sum, d) => sum + d, 0) / gp
      : 0;
  }

  // 4. Iterative SCHED — 15 passes
  //    rating[team] = AGD[team] + avg(rating[opponent] for each opponent)
  let rating = { ...agd };

  for (let pass = 0; pass < PASSES; pass++) {
    const next = {};
    for (const id of teamIds) {
      const opps = stats[id].opponents;
      if (opps.length === 0) {
        next[id] = agd[id];
        continue;
      }
      const schedSum = opps.reduce((sum, oppId) => sum + (rating[oppId] || 0), 0);
      const sched = schedSum / opps.length;
      next[id] = agd[id] + sched;
    }
    rating = next;
  }

  // Final sched = rating - agd
  const sched = {};
  for (const id of teamIds) {
    sched[id] = rating[id] - agd[id];
  }

  // 5. Sort by rating descending and assign ranks
  const sorted = [...teamIds].sort((a, b) => rating[b] - rating[a]);

  const weekEnding = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 6. Upsert into ratings table
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i];
    const s  = stats[id];
    await db.upsertRating({
      team_id:      id,
      season,
      week_ending:  weekEnding,
      rating:       parseFloat(rating[id].toFixed(4)),
      rank:         i + 1,
      agd:          parseFloat(agd[id].toFixed(4)),
      sched:        parseFloat(sched[id].toFixed(4)),
      wins:         s.wins,
      losses:       s.losses,
      games_played: s.goalDiffs.length,
    });
  }

  // Print top-10 to console
  console.log(`\n  Top 10 — ${weekEnding}`);
  console.log('  Rank  Team ID  Rating    AGD       Sched     W   L');
  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const id = sorted[i];
    const s  = stats[id];
    console.log(
      `  ${String(i + 1).padStart(4)}  ${String(id).padStart(7)}  ` +
      `${rating[id].toFixed(4).padStart(8)}  ${agd[id].toFixed(4).padStart(8)}  ` +
      `${sched[id].toFixed(4).padStart(8)}  ${s.wins}   ${s.losses}`
    );
  }

  console.log(`\n  Upserted ${sorted.length} ratings.`);
}

module.exports = { computeRatings };
