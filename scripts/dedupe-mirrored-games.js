#!/usr/bin/env node
/**
 * Collapse the six mirrored cross-source games, logging the orientation
 * disagreement first.
 *
 * THE BUG. `uq_game (season, home_team_id, away_team_id, game_date)` is
 * ORIENTATION-SENSITIVE: (home=nelson, away=richland) and (home=richland,
 * away=nelson) are different keys, so the constraint permits both. The WHSBLA
 * importer's in-memory key `${season}|${hid}|${aid}|${date}` has the same flaw.
 * That is why source-precedence correctly deferred 22 games to OHSLA and missed
 * exactly the 6 where the two leagues disagree about who was home.
 *
 * Effect today: both Oregon's and Washington's Scores boards render those six
 * games TWICE, and four team records are inflated —
 *
 *     nelson             15-4  ->  14-4
 *     richland_wa        18-5  ->  18-4
 *     bend_caldera        6-7  ->   6-6
 *     faith_lutheran_nv   2-1  ->   1-1
 *
 * KEEPER = the OHSLA row, all six. Consistent with source precedence: ohsla owns
 * games it recorded, and these predate the WHSBLA import.
 *
 * SURFACE, DON'T ADJUDICATE. The orientation disagreement is a real discrepancy in
 * the two leagues' record books, not a data-entry error we get to silently pick a
 * side on. So each pair logs a `source_conflicts` row (field
 * `home_away_orientation`) carrying BOTH orientations before the WHSBLA row is
 * deleted. The delete removes a duplicate; the conflict row preserves the fact that
 * two governing bodies recorded the same game differently.
 *
 *   node scripts/dedupe-mirrored-games.js --target=staging [--commit]
 *
 * Dry run by default.
 */
const pool = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const KEEP_SOURCE = 'ohsla';
const DROP_SOURCE = 'whsbla';
const SEASON = 2026;

(async () => {
  const c = await pool.getConnection();
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (rolls back)'}\n`);
  try {
    await c.beginTransaction();

    const [pairs] = await c.execute(
      `SELECT DATE_FORMAT(g.game_date,'%Y-%m-%d') d,
              LEAST(g.home_team_id, g.away_team_id) a,
              GREATEST(g.home_team_id, g.away_team_id) b,
              COUNT(*) n
         FROM games g
        WHERE g.season = ?
        GROUP BY d, a, b
       HAVING COUNT(*) > 1
        ORDER BY d`, [SEASON]);
    console.log(`  duplicate matchups found: ${pairs.length}`);

    let logged = 0, deleted = 0;
    for (const p of pairs) {
      const [rows] = await c.execute(
        `SELECT g.id, g.canonical_source src, g.home_team_id h, g.away_team_id aw,
                ht.slug hs, at2.slug aws
           FROM games g
           JOIN teams ht  ON ht.id  = g.home_team_id
           JOIN teams at2 ON at2.id = g.away_team_id
          WHERE g.season = ? AND DATE(g.game_date) = ?
            AND LEAST(g.home_team_id,g.away_team_id) = ?
            AND GREATEST(g.home_team_id,g.away_team_id) = ?`,
        [SEASON, p.d, p.a, p.b]);

      const keep = rows.find(r => r.src === KEEP_SOURCE);
      const drop = rows.filter(r => r.src === DROP_SOURCE);
      if (!keep || !drop.length) {
        throw new Error(`${p.d}: expected one ${KEEP_SOURCE} + one ${DROP_SOURCE}, got ` +
                        rows.map(r => `${r.id}:${r.src}`).join(', '));
      }

      for (const d of drop) {
        const sameOrientation = d.h === keep.h;
        console.log(`\n  ${p.d}  keep #${keep.id} (${keep.hs} home)  drop #${d.id} (${d.hs} home)` +
                    `  orientation ${sameOrientation ? 'AGREES' : 'DISAGREES'}`);

        if (!sameOrientation) {
          // Surface the disagreement against the SURVIVING game id, so it is still
          // reachable after the delete.
          await c.execute(
            `INSERT INTO source_conflicts
               (game_id, field, owner_source, owner_value, other_source, other_value,
                first_seen_at, last_seen_at)
             VALUES (?, 'home_away_orientation', ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE other_value = VALUES(other_value), last_seen_at = NOW()`,
            [keep.id, KEEP_SOURCE, `home=${keep.hs} away=${keep.aws}`,
             DROP_SOURCE, `home=${d.hs} away=${d.aws}`]);
          logged++;
          console.log(`      logged conflict: ${KEEP_SOURCE} home=${keep.hs} | ${DROP_SOURCE} home=${d.hs}`);
        }

        const [r] = await c.execute('DELETE FROM games WHERE id = ? AND canonical_source = ?',
                                    [d.id, DROP_SOURCE]);
        if (r.affectedRows !== 1) throw new Error(`delete of #${d.id} affected ${r.affectedRows} rows`);
        deleted++;
      }
    }

    // Prove it worked before deciding to keep it.
    const [[left]] = await c.execute(
      `SELECT COUNT(*) n FROM (
         SELECT 1 FROM games WHERE season = ?
          GROUP BY DATE_FORMAT(game_date,'%Y-%m-%d'),
                   LEAST(home_team_id,away_team_id), GREATEST(home_team_id,away_team_id)
         HAVING COUNT(*) > 1) x`, [SEASON]);
    console.log(`\n  conflicts logged: ${logged}   rows deleted: ${deleted}`);
    console.log(`  duplicate matchups remaining: ${left.n}`);
    if (left.n !== 0) throw new Error('duplicates remain');

    const [recs] = await c.execute(
      `SELECT t.slug, r.wins, r.losses FROM v_team_season_record r
         JOIN teams t ON t.id = r.team_id
        WHERE r.season = ? AND t.slug IN ('nelson','richland_wa','bend_caldera','faith_lutheran_nv')
        ORDER BY t.slug`, [SEASON]);
    console.log('  affected records now:');
    recs.forEach(r => console.log(`    ${r.slug.padEnd(20)} ${r.wins}-${r.losses}`));

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
