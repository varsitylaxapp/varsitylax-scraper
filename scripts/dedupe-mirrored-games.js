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

      // KEEPER BY PRIORITY, NOT BY NAME.
      //
      // This script was written for the WA case and hardcoded "one ohsla + one whsbla".
      // Window #5 fed it an ohsla/laxnumbers pair — the mirrored Borah fixtures exposed
      // by the borah_id merge — and it threw and rolled back. Refusing was the right
      // behaviour and the hardcoding was the wrong reason: the law it should have been
      // reading is `game_source_priority`, the same table apply-team-merges.js now
      // consults, so a pair from any two sources resolves the same way.
      //
      // A tie or an unknown source still throws: two rows from the SAME source are not a
      // cross-source duplicate, and this script must not guess which of them is real.
      const [prio] = await c.execute('SELECT source, priority FROM game_source_priority');
      const rank = Object.fromEntries(prio.map(r => [r.source, r.priority]));
      const ordered = [...rows].sort((x, y) => (rank[y.src] ?? -1) - (rank[x.src] ?? -1));
      const keep = ordered[0];
      const drop = ordered.slice(1);
      if (!keep || !drop.length) {
        throw new Error(`${p.d}: expected two rows from different sources, got ` +
                        rows.map(r => `${r.id}:${r.src}`).join(', '));
      }
      if (drop.some(d => (rank[d.src] ?? -1) === (rank[keep.src] ?? -1))) {
        throw new Error(`${p.d}: sources tie on priority (${rows.map(r => `${r.id}:${r.src}`).join(', ')})` +
                        ` — a same-source pair is not a cross-source duplicate`);
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
            [keep.id, keep.src, `home=${keep.hs} away=${keep.aws}`,
             d.src, `home=${d.hs} away=${d.aws}`]);
          logged++;
          console.log(`      logged conflict: ${keep.src} home=${keep.hs} | ${d.src} home=${d.hs}`);
        }

        const [r] = await c.execute('DELETE FROM games WHERE id = ? AND canonical_source = ?',
                                    [d.id, d.src]);
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
