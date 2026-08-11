#!/usr/bin/env node
//
// seed-team-seasons.js — open a season row for teams that have a season but no row.
//
// WHY THIS EXISTS
//
// Window #4-lite shipped AZ/ID/MT/NV with teams, games and rankings and **zero
// `team_seasons` rows**. The LaxNumbers game importer creates teams and writes games; it
// never opens a season. Prod today:
//
//     OR 41/41    WA 75/77    AZ 0/18    ID 0/32    MT 0/7    NV 0/16
//
// It is invisible from the app, which is why it survived a whole window: `/api/v2/teams`
// LEFT JOINs `team_seasons`, so a missing row costs a null conference and a null record,
// not a missing team. Nothing looks broken. It surfaced only when scoping `/teams` by
// season was modelled — an INNER JOIN drops 0 Oregon rows, 2 Washington rows (both
// correct) and all 73 rows in the four new states.
//
// SO THIS RUNS FIRST. Seed, then scope. The reverse order empties the Teams tab in the
// four states a league board member is currently testing.
//
// WHAT IT WILL NOT DO
//
// It does not invent membership. A row is opened only for a team that DEMONSTRABLY
// played that season — it appears in a game, or in a rankings snapshot. `conference` and
// `division` stay NULL: those are league facts, and no league published them for these
// four. Wins/losses are left at 0 for `refreshWinLoss()` to compute from the games, the
// same path Oregon's records come from, rather than being written here from a second
// derivation that could disagree with the first.
//
// USAGE
//     node scripts/seed-team-seasons.js --states=AZ,ID,MT,NV [--season 2026] [--apply]
//
// Dry run is the DEFAULT. Without --apply it prints the plan and writes nothing.
//
// EXIT
//     0  ok (dry run, or applied)
//     1  refused — nothing was written
//     2  could not run

const db = require('./../src/db');
const { isValidState } = require('./../src/config/states');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function flag(name, fallback) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  // Only take the next entry when it is a VALUE, never another flag. The audit script
  // shipped with this bug: `--json` alone made the positional branch read argv[0], the
  // season parsed as NaN, and the gate reported clean. See RELEASE.md, ledger member 7.
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}

const SEASON = parseInt(flag('season', process.env.SEASON || '2026'), 10);
if (!Number.isInteger(SEASON) || SEASON < 2000 || SEASON > 2100) {
  console.error(`[seed-team-seasons] FATAL: bad season`); process.exit(2);
}
const STATES = String(flag('states', '')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!STATES.length) { console.error('[seed-team-seasons] FATAL: --states is required'); process.exit(2); }
for (const s of STATES) {
  if (!isValidState(s)) { console.error(`[seed-team-seasons] FATAL: '${s}' is not a registered state`); process.exit(2); }
}

async function q(sql, p = []) { return (await db.execute(sql, p))[0]; }

(async () => {
  const placeholders = STATES.map(() => '?').join(',');

  // Evidence of a season: a game, or a ranking entry. Both, so a team that was ranked but
  // never had a game imported still gets a row — and so does a team that played but was
  // never rated, which is exactly the cross-border-only case the audit flags.
  const candidates = await q(`
    SELECT t.id, t.slug, t.state,
           SUM(ev.viaGame)    AS games,
           SUM(ev.viaRanking) AS rankings
    FROM teams t
    JOIN (
      SELECT g.home_team_id AS team_id, 1 AS viaGame, 0 AS viaRanking FROM games g WHERE g.season = ?
      UNION ALL
      SELECT g.away_team_id, 1, 0 FROM games g WHERE g.season = ?
      UNION ALL
      SELECT re.team_id, 0, 1 FROM ranking_entries re
        JOIN rankings_snapshots rs ON rs.id = re.snapshot_id AND rs.season = ?
    ) ev ON ev.team_id = t.id
    LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season = ?
    WHERE t.state IN (${placeholders}) AND ts.id IS NULL
    GROUP BY t.id
    ORDER BY t.state, t.slug`, [SEASON, SEASON, SEASON, SEASON, ...STATES]);

  console.log(`\n══ seed team_seasons — season ${SEASON}, states ${STATES.join(',')} ══\n`);

  const before = await q(
    `SELECT t.state, COUNT(DISTINCT t.id) teams, COUNT(DISTINCT ts.team_id) withSeason
     FROM teams t LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season = ?
     WHERE t.state IN (${placeholders}) GROUP BY t.state ORDER BY t.state`, [SEASON, ...STATES]);
  console.log('before:'); for (const r of before) console.log(`   ${r.state}  ${r.withSeason}/${r.teams}`);

  console.log(`\n${candidates.length} team(s) have ${SEASON} evidence and no season row:`);
  for (const c of candidates) {
    console.log(`   ${c.state}:${c.slug.padEnd(26)} games=${c.games} rankings=${c.rankings}`);
  }

  if (!candidates.length) { console.log('\nnothing to do\n'); process.exit(0); }
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to insert ${candidates.length} row(s).\n`);
    process.exit(0);
  }

  let inserted = 0;
  for (const c of candidates) {
    // conference/division NULL and wins/losses 0 deliberately — see the header.
    const [r] = await db.execute(
      `INSERT IGNORE INTO team_seasons (team_id, season, conference, division, wins, losses)
       VALUES (?, ?, NULL, NULL, 0, 0)`, [c.id, SEASON]);
    inserted += r.affectedRows;
  }

  // RECORDS ARE COMPUTED IN THE SAME BREATH, not left for a later step.
  //
  // A seeded row carries wins = losses = 0, and `/api/v2/teams` renders `record` from
  // wins whenever wins is non-null — so the instant these rows exist, every team in four
  // states shows **0-0** in the app instead of a blank. Seeding and then recomputing in
  // two separate steps leaves that visible to whoever opens the app in between, which for
  // this window is the league board member the window is for.
  await require('./../src/dual-write').refreshWinLoss(SEASON);

  const after = await q(
    `SELECT t.state, COUNT(DISTINCT t.id) teams, COUNT(DISTINCT ts.team_id) withSeason,
            SUM(CASE WHEN ts.wl_computed_at IS NOT NULL THEN 1 ELSE 0 END) AS recordsComputed
     FROM teams t LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season = ?
     WHERE t.state IN (${placeholders}) GROUP BY t.state ORDER BY t.state`, [SEASON, ...STATES]);
  console.log(`\ninserted ${inserted} row(s), records recomputed\n\nafter:`);
  for (const r of after) console.log(`   ${r.state}  ${r.withSeason}/${r.teams}  records computed: ${r.recordsComputed}`);

  // The point of the exercise, asserted rather than assumed: every team with evidence of
  // this season now has a row, so scoping /teams by season cannot drop one.
  const [{ missing }] = await q(`
    SELECT COUNT(*) AS missing FROM (
      SELECT DISTINCT t.id FROM teams t
      JOIN (SELECT home_team_id AS team_id FROM games WHERE season = ?
            UNION SELECT away_team_id FROM games WHERE season = ?) ev ON ev.team_id = t.id
      LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season = ?
      WHERE t.state IN (${placeholders}) AND ts.id IS NULL) x`,
    [SEASON, SEASON, SEASON, ...STATES]);
  if (missing > 0) { console.error(`\nFAIL: ${missing} team(s) still without a season row\n`); process.exit(1); }
  console.log('\nok — every team with a game this season has a season row\n');
  process.exit(0);
})().catch(err => { console.error('[seed-team-seasons] FATAL:', err.message); process.exit(2); });
