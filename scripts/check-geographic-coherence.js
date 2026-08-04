#!/usr/bin/env node
/**
 * Does each team's imported schedule look like a team from that state actually played it?
 *
 *   ./scripts/staging scripts/check-geographic-coherence.js
 *   ./scripts/staging scripts/check-geographic-coherence.js --source=laxnumbers
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — the Mountain View collision, 2026-08-04.
 *
 * Three schools share the name "Mountain View": Oregon's, Washington's, and Idaho's. A
 * roster lookup that searched globally while importing a single state found Washington's,
 * concluded Idaho's already existed, and created nothing. Thirteen Idaho games — every one
 * against Boise-area opposition — were written onto a Bellevue team's season.
 *
 * EVERY EXISTING CHECK PASSED. The count ladder closed at UNEXPLAINED 0, because every row
 * was accounted for. The payload diff was additions-only. Source-conflict logging saw
 * nothing, because there was no conflict — one team simply absorbed another's season. The
 * defect was reported UP as a good result: "fifteen genuine cross-border games our curated
 * sources never had", of which thirteen were corruption.
 *
 * Structural checks verify that rows are EXPLAINED. Only a truth-anchored check verifies
 * that they are TRUE. This is that check, and its anchor is geography: a Bellevue school
 * does not play thirteen straight games in Boise.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FLAGGED, NOT REJECTED. Border programmes and tournament schedules are real — an El Paso
 * team plays New Mexico, a Nevada team flies to a California showcase. The threshold
 * catches the shape of a misattributed SEASON, not the existence of travel, and a human
 * reads every flag.
 *
 * ONLY TEAMS INSIDE THE IMPORT'S SCOPE ARE EVALUATED, and this is not a convenience.
 * A California placeholder exists here only because an Arizona team played it; we never
 * import California's schedule, so its same-state share is 0% BY CONSTRUCTION and says
 * nothing at all. Judging it would flag every out-of-region opponent forever and train
 * the reader to ignore the output — which is how a real flag gets missed.
 *
 * Pass --states with the states the import actually covered.
 *
 * Opponents with an unknown state are EXCLUDED from the ratio rather than counted against
 * it. A placeholder we deliberately declined to place (see data/placeholder-states.json)
 * says nothing about whether a schedule is coherent, and counting it as "not same-state"
 * would flag exactly the teams that play the most out-of-region opposition — which is
 * information we do not have, not evidence of a defect.
 */
const pool = require('../src/db');

const SOURCE = (process.argv.find(a => a.startsWith('--source=')) || '--source=laxnumbers').split('=')[1];
const SEASON = parseInt((process.argv.find(a => a.startsWith('--season=')) || '--season=2026').split('=')[1]);
const SCOPE = (process.argv.find(a => a.startsWith('--states=')) || '--states=').split('=')[1]
  .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const MIN_GAMES = 3;      // below this, a ratio means nothing
const MIN_SHARE = 0.50;   // same-state share at or above this is coherent

(async () => {
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  source: ${SOURCE}   season: ${SEASON}`);
  console.log(`  rule:   flag a team with >= ${MIN_GAMES} imported games whose same-state`);
  console.log(`          share is below ${(MIN_SHARE * 100).toFixed(0)}% (unknown-state opponents excluded)\n`);

  const [rows] = await pool.execute(
    `SELECT t.id, t.slug, t.name, t.state,
            SUM(1)                                                        AS imported,
            SUM(CASE WHEN opp.state IS NOT NULL THEN 1 ELSE 0 END)        AS known,
            SUM(CASE WHEN opp.state = t.state THEN 1 ELSE 0 END)          AS same,
            GROUP_CONCAT(DISTINCT opp.state ORDER BY opp.state)           AS oppStates
       FROM games g
       JOIN teams t   ON t.id  = g.home_team_id OR t.id  = g.away_team_id
       JOIN teams opp ON opp.id = CASE WHEN t.id = g.home_team_id
                                       THEN g.away_team_id ELSE g.home_team_id END
      WHERE g.season = ? AND g.canonical_source = ? AND t.state IS NOT NULL
      GROUP BY t.id, t.slug, t.name, t.state
      ORDER BY t.state, t.name`, [SEASON, SOURCE]);

  const flags = [];
  let checked = 0, outOfScope = 0;
  for (const r of rows) {
    const known = Number(r.known), same = Number(r.same), imported = Number(r.imported);
    if (SCOPE.length && !SCOPE.includes(r.state)) { outOfScope++; continue; }
    if (imported < MIN_GAMES || known === 0) continue;
    checked++;
    const share = same / known;
    if (share < MIN_SHARE) {
      flags.push({ ...r, share, known, same, imported });
    }
  }

  console.log(`  teams with an imported schedule: ${rows.length}   eligible for the ratio: ${checked}`);
  if (SCOPE.length) {
    console.log(`  scope: ${SCOPE.join(', ')}   outside it and therefore not judged: ${outOfScope}`);
  } else {
    console.log(`  scope: ALL STATES — pass --states=... or out-of-region opponents flag by construction`);
  }

  if (!flags.length) {
    console.log(`\n  ✓ no team flagged — every imported schedule is geographically coherent\n`);
  } else {
    console.log(`\n  ${flags.length} TEAM(S) FLAGGED FOR HUMAN REVIEW:\n`);
    for (const f of flags) {
      console.log(`    ${f.slug} [${f.state}] — ${f.same}/${f.known} same-state ` +
                  `(${(f.share * 100).toFixed(0)}%), ${f.imported} imported`);
      console.log(`      opponents from: ${f.oppStates}`);
    }
    console.log('\n  A flag is a question, not a verdict. Border programmes and tournament');
    console.log('  schedules are real; a season attributed to the wrong school is not.\n');
    process.exitCode = 1;
  }

  // The regression fixture: the team the collision created, which must look Idahoan.
  const [[mv]] = await pool.execute(
    `SELECT t.slug, t.state,
            SUM(CASE WHEN opp.state = t.state THEN 1 ELSE 0 END) same,
            SUM(CASE WHEN opp.state IS NOT NULL THEN 1 ELSE 0 END) known
       FROM games g
       JOIN teams t   ON t.id = g.home_team_id OR t.id = g.away_team_id
       JOIN teams opp ON opp.id = CASE WHEN t.id = g.home_team_id
                                       THEN g.away_team_id ELSE g.home_team_id END
      WHERE g.season = ? AND t.slug = 'mountain_view_id'`, [SEASON]);
  if (mv && Number(mv.known) > 0) {
    const pct = (Number(mv.same) / Number(mv.known) * 100).toFixed(0);
    console.log(`  regression fixture — mountain_view_id: ${mv.same}/${mv.known} same-state (${pct}%)`);
    console.log(`    the team the collision created. 100% is the expected shape;`);
    console.log(`    before the fix these games sat on mountain_view_wa at 0%.\n`);
  }
  await pool.end();
})();
