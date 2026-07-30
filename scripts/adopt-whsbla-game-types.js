#!/usr/bin/env node
/**
 * Adopt WHSBLA's `game_type` on the six deduped cross-source games, keeping the
 * OHSLA rows and OHSLA's ownership.
 *
 * WHY. Deduping those six kept the OHSLA row per source precedence — and with it
 * OHSLA's `game_type`. WHSBLA had classified FOUR of the six as `exhibition`; OHSLA
 * calls them `non_league`. So the dedupe silently discarded the better value and
 * moved four games back INTO record math, undoing part of the earlier gameType work
 * for exactly the games P5 names as its EXH fixtures.
 *
 * FOUR, not five — corrected here. Oregon's pre-dedupe feed carried
 * `exhibition: 4`, and the pre-deletion query showed bend_caldera /
 * faith_lutheran_nv as `non_league` in BOTH sources. Two of the six therefore
 * change nothing, which the script asserts rather than assumes.
 *
 * ROW OWNERSHIP AND FIELD AUTHORITY ARE DIFFERENT QUESTIONS. Source precedence
 * answers "whose row is this" — OHSLA's, it recorded the game. It does not answer
 * "who knows what KIND of game this was": that is the league that scheduled the
 * fixture, and for a WHSBLA-scheduled exhibition against an Oregon opponent, that is
 * WHSBLA. A row-level keeper collapses both questions into one and loses whichever
 * fields the loser knew better.
 *
 * So this is a FIELD-level merge, and it uses the same shape the importer already
 * uses for cross-source disagreement: compare, log a `source_conflicts` row carrying
 * both values, then apply the authoritative one. Nothing is discarded silently —
 * which is the whole difference from what the dedupe did.
 *
 *   node scripts/adopt-whsbla-game-types.js --target=staging [--commit]
 *
 * Dry run by default. Idempotent.
 *
 * The WHSBLA-side rows are already deleted, so their game_type is recovered from the
 * export via scripts/whsbla-extract.py's classification rule rather than from the DB:
 * a cross-state non-league fixture in the WHSBLA schedule is an exhibition. The six
 * games and their export classification are listed explicitly below rather than
 * re-derived, because the source rows no longer exist to re-derive them from.
 */
const pool = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const OWNER = 'ohsla';        // whose row survives
const AUTHORITY = 'whsbla';   // whose game_type wins

// slug pair -> the type WHSBLA recorded in its export. nelson/richland_wa was
// non_league in BOTH sources, so it is listed and expected to be a no-op — proving
// the script changes only what genuinely disagreed.
const EXPORT_TYPES = [
  ['nelson', 'richland_wa',        '2026-03-20', 'non_league'],
  ['bend_caldera', 'faith_lutheran_nv', '2026-03-27', 'non_league'],
  ['grant', 'nanaimo_bc',          '2026-03-28', 'exhibition'],
  ['lakeridge', 'palo_verde_nv',   '2026-03-28', 'exhibition'],
  ['grant', 'palo_verde_nv',       '2026-03-29', 'exhibition'],
  ['summit', 'claremont_bc',       '2026-03-29', 'exhibition'],
];

(async () => {
  const c = await pool.getConnection();
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (rolls back)'}\n`);
  try {
    await c.beginTransaction();
    const [teams] = await c.execute('SELECT id, slug FROM teams');
    const id = Object.fromEntries(teams.map(t => [t.slug, t.id]));

    let changed = 0, noop = 0, logged = 0;
    for (const [aSlug, bSlug, date, exportType] of EXPORT_TYPES) {
      const [lo, hi] = id[aSlug] <= id[bSlug] ? [id[aSlug], id[bSlug]] : [id[bSlug], id[aSlug]];
      const [[g]] = await c.execute(
        `SELECT id, game_type, canonical_source FROM games
          WHERE season=2026 AND LEAST(home_team_id,away_team_id)=?
            AND GREATEST(home_team_id,away_team_id)=? AND game_date=?`, [lo, hi, date]);
      if (!g) throw new Error(`${date} ${aSlug}/${bSlug}: game not found`);
      if (g.canonical_source !== OWNER) {
        throw new Error(`#${g.id} is owned by ${g.canonical_source}, expected ${OWNER}`);
      }

      if (g.game_type === exportType) {
        console.log(`  #${g.id} ${date} ${aSlug}/${bSlug}: both say ${exportType} — no change`);
        noop++;
        continue;
      }

      // Log the disagreement BEFORE applying it. owner_value is what OHSLA held;
      // other_value is what WHSBLA said and what we are adopting.
      await c.execute(
        `INSERT INTO source_conflicts
           (game_id, field, owner_source, owner_value, other_source, other_value,
            resolution, resolved_at, first_seen_at, last_seen_at)
         VALUES (?, 'game_type', ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
         ON DUPLICATE KEY UPDATE owner_value=VALUES(owner_value),
           other_value=VALUES(other_value), resolution=VALUES(resolution),
           resolved_at=NOW(), last_seen_at=NOW()`,
        [g.id, OWNER, g.game_type, AUTHORITY, exportType,
         'adopted whsbla — the scheduling league is authoritative on game kind']);
      logged++;

      const [r] = await c.execute(
        `UPDATE games SET game_type = ?, is_scrimmage = ? WHERE id = ?`,
        [exportType, exportType === 'exhibition' || exportType === 'practice' ? 1 : 0, g.id]);
      if (r.affectedRows !== 1) throw new Error(`#${g.id}: update affected ${r.affectedRows}`);
      console.log(`  #${g.id} ${date} ${aSlug}/${bSlug}: ${g.game_type} -> ${exportType}  (conflict logged)`);
      changed++;
    }

    console.log(`\n  changed ${changed}   unchanged ${noop}   conflicts logged ${logged}`);
    const [[ex]] = await c.execute(
      `SELECT COUNT(*) n FROM games WHERE season=2026 AND game_type='exhibition'`);
    console.log(`  exhibitions in 2026 now: ${ex.n}`);

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
