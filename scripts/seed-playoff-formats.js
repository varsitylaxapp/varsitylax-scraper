#!/usr/bin/env node
/**
 * Seed `playoff_formats` for a season, DERIVING each bracket's shape from the game
 * graph rather than from a table of numbers I typed.
 *
 * The six 2026 brackets are declared below by their FINAL's natural key — that and
 * the display name are the only hand-entered facts. Field size and play-in count are
 * computed from the games reachable backward from each final, then cross-checked:
 *
 *     games == field_size - 1                      (single elimination)
 *     play_in_games == field_size - 2^floor(log2 f) (the optional play-in column)
 *
 * If a declared final does not resolve, or a bracket's arithmetic does not close, the
 * script STOPS. No heuristics, no partial seeds.
 *
 * ACCEPTANCE (ruled): Oregon partitions 38/38 games across two brackets with zero
 * overlap and zero orphans; each WA division partitions into its single bracket.
 * Asserted here, not assumed.
 *
 *   node scripts/seed-playoff-formats.js --target=staging [--commit]
 */
const pool = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const SEASON = 2026;

// The ONLY hand-entered facts: which brackets exist, what they are called, and which
// game is each one's final (by natural key — never by id; see the migration header).
const BRACKETS = [
  { state: 'OR', division_id: null,         key: 'championship', name: 'CHAMPIONSHIP',
    final: ['2026-05-30', 'west_linn', 'sunset'],            sort: 0 },
  { state: 'OR', division_id: null,         key: 'cascade_cup',  name: 'CASCADE CUP',
    final: ['2026-05-30', 'canby', 'newberg'],               sort: 1 },
  { state: 'WA', division_id: 'wa_4a',      key: 'wa_4a',        name: '4A',
    final: ['2026-05-23', 'eastlake_wa', 'mount_si_wa'],     sort: 0 },
  { state: 'WA', division_id: 'wa_3a',      key: 'wa_3a',        name: '3A',
    final: ['2026-05-23', 'snohomish_wa', 'ballard_wa'],     sort: 1 },
  { state: 'WA', division_id: 'wa_2a',      key: 'wa_2a',        name: '2A',
    final: ['2026-05-23', 'selah_wa', 'anacortes_wa'],       sort: 2 },
  { state: 'WA', division_id: 'wa_private', key: 'wa_private',   name: 'PV/Open',
    final: ['2026-05-23', 'seattle_prep_wa', 'bellevue_wa'], sort: 3 },
];

// The walk itself lives in src/playoff-graph.js, shared with /schedule/playoffs.
// It was duplicated here first; that is exactly the drift this project has already been
// bitten by, so the seeder and the endpoint now derive from ONE implementation. If the
// partition is wrong, it is wrong in both places at once and this script's acceptance
// assertions catch it before anything ships.
const { assignBrackets } = require('../src/playoff-graph');

const expectedPlayIn = f => f - 2 ** Math.floor(Math.log2(f));

(async () => {
  const c = await pool.getConnection();
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (rolls back)'}\n`);
  try {
    await c.beginTransaction();

    // Playoff games per state. WA is division-scoped, OR is statewide.
    const [all] = await c.execute(
      `SELECT g.id, DATE_FORMAT(g.game_date,'%Y-%m-%d') d, g.home_team_id h, g.away_team_id a,
              g.home_score hs, g.away_score as_, ht.slug hslug, at2.slug aslug,
              ht.state hstate, at2.state astate, ts.division_id AS division
         FROM games g
         JOIN teams ht ON ht.id = g.home_team_id
         JOIN teams at2 ON at2.id = g.away_team_id
         LEFT JOIN team_seasons ts ON ts.team_id = g.home_team_id AND ts.season = g.season
        WHERE g.season = ? AND g.game_type = 'playoff' AND g.status = 'completed'`,
      [SEASON]);

    const [teams] = await c.execute('SELECT id, slug FROM teams');
    const idBySlug = Object.fromEntries(teams.map(t => [t.slug, t.id]));

    // Shape the rows for the shared graph module: team identity is the SLUG.
    const graphGames = all.map(g => ({
      id: g.id, date: g.d, home: g.hslug, away: g.aslug,
      homeScore: g.hs, awayScore: g.as_,
      homeState: g.hstate, awayState: g.astate, division: g.division,
    }));
    const byId = new Map(graphGames.map(g => [g.id, g]));

    const rows = [];

    for (const b of BRACKETS) {
      const [fd, s1, s2] = b.final;
      if (!idBySlug[s1] || !idBySlug[s2]) throw new Error(`${b.key}: unknown slug in ${s1}/${s2}`);
      const pair = [s1, s2].sort();
      const pool = b.division_id
        ? (g => g.division === b.division_id)
        : (g => g.homeState === b.state && g.awayState === b.state);
      const final = graphGames.find(g =>
        pool(g) && g.date === fd && [g.home, g.away].sort().join('|') === pair.join('|'));
      if (!final) throw new Error(`${b.key}: ANCHOR DID NOT RESOLVE — no ${fd} game between ` +
        `${s1} and ${s2}. Either the final moved or the pair is wrong. Stopping rather than guessing.`);
      rows.push({ ...b, finalId: final.id, pool,
                  finalDate: fd, lo: pair[0], hi: pair[1] });
    }

    // ONE call, per state, so overlap detection sees every bracket in that state.
    for (const state of [...new Set(BRACKETS.map(b => b.state))]) {
      const mine = rows.filter(r => r.state === state);
      const { assignment, orphans, overlaps } = assignBrackets(
        graphGames, mine.map(r => ({ key: r.key, finalGameId: r.finalId, pool: r.pool })));

      for (const r of mine) {
        const size = [...assignment.values()].filter(a => a.bracketKey === r.key).length;
        r.fieldSize = size + 1;                        // single elimination
        r.playIn = expectedPlayIn(r.fieldSize);
        console.log(`  ${r.state} ${r.key.padEnd(13)} final #${r.finalId}  ` +
          `${size} games → field ${r.fieldSize}, play-in ${r.playIn}`);
      }

      // ── acceptance: partition, no orphans, no overlaps ──
      const claimed = graphGames.filter(g => mine.some(r => r.pool(g)));
      console.log(`  ${state}: ${assignment.size}/${claimed.length} games assigned, ` +
        `${orphans.length} orphan(s), ${overlaps.length} overlap(s)\n`);
      if (overlaps.length) {
        overlaps.forEach(o => console.log(`      OVERLAP #${o.id} claimed by ${o.claimedBy.join(' and ')}`));
        throw new Error(`${state}: ${overlaps.length} overlapping game(s) — stop-and-report`);
      }
      if (orphans.length) {
        orphans.forEach(o => { const g = byId.get(o.id);
          console.log(`      ORPHAN #${g.id} ${g.date} ${g.home} ${g.homeScore}-${g.awayScore} ${g.away}`); });
        throw new Error(`${state}: ${orphans.length} orphan game(s) — stop-and-report, not a heuristic`);
      }
    }

    await c.execute('DELETE FROM playoff_formats WHERE season = ?', [SEASON]);
    for (const r of rows) {
      await c.execute(
        `INSERT INTO playoff_formats
           (season, state, division_id, bracket_key, display_name, field_size,
            play_in_games, final_date, final_slug_lo, final_slug_hi, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [SEASON, r.state, r.division_id, r.key, r.name, r.fieldSize,
         r.playIn, r.finalDate, r.lo, r.hi, r.sort]);
    }

    const [[anchored]] = await c.execute(
      'SELECT COUNT(*) n FROM v_playoff_format_anchors WHERE season = ?', [SEASON]);
    console.log(`\n  seeded ${rows.length}   anchors resolving through the view: ${anchored.n}`);
    if (anchored.n !== rows.length) {
      throw new Error(`${rows.length - anchored.n} format(s) do not resolve to a game`);
    }

    if (COMMIT) { await c.commit(); console.log('  COMMITTED\n'); }
    else        { await c.rollback(); console.log('  rolled back (dry run)\n'); }
  } catch (err) {
    await c.rollback();
    console.error(`\n  ROLLED BACK: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
