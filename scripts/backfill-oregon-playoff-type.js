#!/usr/bin/env node
/**
 * Type Oregon's 2026 postseason games as `game_type = 'playoff'`.
 *
 * WHY. `game_type` should be the single signal for "is this a playoff game", but
 * Oregon has ZERO rows carrying it — the OHSLA scraper never set it. So
 * `/schedule/playoffs` infers playoffs from a DATE WINDOW (`>= 2026-05-14`) instead,
 * and that inference is wrong for Washington in the other direction: WA has 43 games
 * correctly typed `playoff`, 19 of them BEFORE 2026-05-14, which the date window
 * silently drops.
 *
 * One signal, two definitions, disagreeing per state. This backfills the column for
 * Oregon so the endpoint can prefer it everywhere, keeping the date window only as a
 * fallback for a state where the column was never populated.
 *
 * COMPLETED GAMES ONLY — ruled, and load-bearing. Oregon's window contains games
 * still `status = 'scheduled'` in a finished season: stale placeholders and quiet
 * cancellations. Typing one of those `playoff` would place an unplayed cell inside a
 * bracket as though it were awaiting a result the season can never produce. The
 * worked example is Marist/Newberg — v1 still carries a 2026-05-26 scheduled row
 * scraped before OHSLA moved the fixture to the 27th, where it was played 10-11.
 *
 * BOTH PARTICIPANTS OREGON. Every game in Oregon's window is OR-vs-OR, so this is
 * precise rather than restrictive — and it guarantees the sweep cannot reach a
 * cross-border game that Washington already types.
 *
 *   node scripts/backfill-oregon-playoff-type.js --target=staging [--commit]
 *
 * Dry run by default. Idempotent.
 */
const pool = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const SEASON = 2026;
const WINDOW_START = process.env.PLAYOFFS_START || `${SEASON}-05-14`;

(async () => {
  const c = await pool.getConnection();
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (rolls back)'}`);
  console.log(`  window: >= ${WINDOW_START}\n`);
  try {
    await c.beginTransaction();

    const [candidates] = await c.execute(
      `SELECT g.id, DATE_FORMAT(g.game_date,'%Y-%m-%d') d, g.status, g.game_type,
              ht.slug home, at2.slug away
         FROM games g
         JOIN teams ht  ON ht.id  = g.home_team_id
         JOIN teams at2 ON at2.id = g.away_team_id
        WHERE g.season = ? AND g.game_date >= ?
          AND ht.state = 'OR' AND at2.state = 'OR'
        ORDER BY g.game_date, g.id`, [SEASON, WINDOW_START]);

    const completed = candidates.filter(r => r.status === 'completed' && r.game_type !== 'playoff');
    const skippedSched = candidates.filter(r => r.status !== 'completed');
    const already = candidates.filter(r => r.game_type === 'playoff');

    console.log(`  in Oregon's window:        ${candidates.length}`);
    console.log(`    already typed playoff:   ${already.length}`);
    console.log(`    NOT completed — SKIPPED: ${skippedSched.length}`);
    skippedSched.forEach(r => console.log(`        #${r.id} ${r.d} ${r.home} vs ${r.away} [${r.status}]`));
    console.log(`    to type as playoff:      ${completed.length}`);

    if (completed.length) {
      const ids = completed.map(r => r.id);
      const [r] = await c.query(
        `UPDATE games SET game_type = 'playoff' WHERE id IN (?)`, [ids]);
      console.log(`\n  UPDATE affected ${r.affectedRows} row(s)`);
      if (r.affectedRows !== completed.length) {
        throw new Error(`expected ${completed.length} rows, affected ${r.affectedRows}`);
      }
    }

    // Post-conditions: survey, don't spot-check.
    const [[orTyped]] = await c.execute(
      `SELECT COUNT(*) n FROM games g JOIN teams ht ON ht.id=g.home_team_id
        WHERE g.season=? AND g.game_type='playoff' AND ht.state='OR'`, [SEASON]);
    const [[waTyped]] = await c.execute(
      `SELECT COUNT(*) n FROM games g JOIN teams ht ON ht.id=g.home_team_id
        WHERE g.season=? AND g.game_type='playoff' AND ht.state='WA'`, [SEASON]);
    const [[schedTyped]] = await c.execute(
      `SELECT COUNT(*) n FROM games WHERE season=? AND game_type='playoff' AND status<>'completed'`,
      [SEASON]);
    console.log(`  OR games typed playoff: ${orTyped.n}`);
    console.log(`  WA games typed playoff: ${waTyped.n}  (unchanged expected)`);
    console.log(`  playoff-typed rows that are NOT completed: ${schedTyped.n}  (must be 0)`);
    if (schedTyped.n !== 0) throw new Error('a non-completed game got typed playoff');

    if (COMMIT) { await c.commit(); console.log('\n  COMMITTED\n'); }
    else        { await c.rollback(); console.log('\n  rolled back (dry run)\n'); }
  } catch (err) {
    await c.rollback();
    console.error(`\n  ROLLED BACK: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
