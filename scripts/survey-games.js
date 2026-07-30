#!/usr/bin/env node
/**
 * Snapshot every distribution the `games` table carries, so a mutation can be
 * surveyed rather than spot-checked.
 *
 * WHY THIS EXISTS. After deduping six mirrored games I verified the four team
 * records I had PREDICTED would change, found them correct, and stopped. The same
 * mutation had also dropped `game_type = exhibition` on five games — because the
 * surviving OHSLA rows classify them `non_league` — which silently moved those games
 * back INTO record math and undid part of an earlier fix. A post-condition that
 * checks the hypothesis confirms the hypothesis. It does not survey the blast radius.
 *
 * So: POST-CONDITIONS SURVEY THE BLAST RADIUS, NOT THE HYPOTHESIS. Dump before,
 * mutate, dump after, diff, and explain EVERY delta — including the ones nobody
 * predicted, especially those.
 *
 *   node scripts/survey-games.js --target=staging > before.json
 *   ... mutate ...
 *   node scripts/survey-games.js --target=staging > after.json
 *   node scripts/survey-games.js --diff before.json after.json
 */
const fs = require('fs');

const DIMENSIONS = [
  ['by_source',        `SELECT canonical_source k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['by_game_type',     `SELECT game_type k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['by_status',        `SELECT status k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['by_status_note',   `SELECT COALESCE(status_note,'<null>') k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['is_overtime',      `SELECT is_overtime k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['is_forfeit',       `SELECT is_forfeit k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['is_scrimmage',     `SELECT is_scrimmage k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['scored',           `SELECT (home_score IS NOT NULL) k, COUNT(*) n FROM games WHERE season=? GROUP BY k`],
  ['by_home_state',    `SELECT t.state k, COUNT(*) n FROM games g JOIN teams t ON t.id=g.home_team_id WHERE g.season=? GROUP BY k`],
  ['by_away_state',    `SELECT t.state k, COUNT(*) n FROM games g JOIN teams t ON t.id=g.away_team_id WHERE g.season=? GROUP BY k`],
  ['total',            `SELECT 'all' k, COUNT(*) n FROM games WHERE season=?`],
  ['conflicts_by_field', `SELECT field k, COUNT(*) n FROM source_conflicts GROUP BY k`],
  // Every team's record, so a change to ANY team's W-L is caught, not just the ones
  // someone thought to look at.
  ['records',          `SELECT CONCAT(t.slug,'=',r.wins,'-',r.losses) k, 1 n
                          FROM v_team_season_record r JOIN teams t ON t.id=r.team_id
                         WHERE r.season=? ORDER BY t.slug`],
];

async function snapshot(season) {
  const pool = require('../src/db');
  const out = { season, target: pool.targetLabel, dimensions: {} };
  for (const [name, sql] of DIMENSIONS) {
    const [rows] = await pool.execute(sql, sql.includes('?') ? [season] : []);
    out.dimensions[name] = Object.fromEntries(rows.map(r => [String(r.k), Number(r.n)]));
  }
  await pool.end();
  return out;
}

function diff(a, b) {
  let deltas = 0;
  for (const name of Object.keys({ ...a.dimensions, ...b.dimensions })) {
    const before = a.dimensions[name] || {};
    const after = b.dimensions[name] || {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const changed = keys.filter(k => (before[k] || 0) !== (after[k] || 0));
    if (!changed.length) continue;
    console.log(`\n  ${name}`);
    for (const k of changed) {
      const x = before[k] || 0, y = after[k] || 0;
      console.log(`    ${k.padEnd(34)} ${String(x).padStart(5)} -> ${String(y).padStart(5)}  (${y - x >= 0 ? '+' : ''}${y - x})`);
      deltas++;
    }
  }
  console.log(deltas ? `\n  ${deltas} delta(s) — EVERY ONE must be explained, not just the expected ones.`
                     : '\n  no deltas in any dimension');
  return deltas;
}

(async () => {
  const args = process.argv.slice(2);
  const di = args.indexOf('--diff');
  if (di !== -1) {
    const a = JSON.parse(fs.readFileSync(args[di + 1], 'utf8'));
    const b = JSON.parse(fs.readFileSync(args[di + 2], 'utf8'));
    console.log(`  ${args[di + 1]} -> ${args[di + 2]}  (season ${a.season}, ${a.target})`);
    diff(a, b);
    return;
  }
  const season = Number((args.find(a => a.startsWith('--season=')) || '--season=2026').split('=')[1]);
  console.log(JSON.stringify(await snapshot(season), null, 1));
})();
