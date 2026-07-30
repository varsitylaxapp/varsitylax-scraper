#!/usr/bin/env node
/**
 * Unit tests for src/playoff-graph.js — the shared partition/round/edge derivation.
 *
 * WHY THIS EXISTS. Two callers now depend on this module (`seed-playoff-formats.js` and
 * `/schedule/playoffs`), the repo has no test target, and several of its branches are
 * NOT reachable from live data: no current (state, season) has playoff games without a
 * declared bracket, nothing has tied, and no two brackets currently overlap. Those
 * branches are the ones that will fire first when March 2027 data arrives malformed, so
 * they are tested against fixtures rather than left to inspection.
 *
 * Real-data coverage is separate and lives in the acceptance run: all 6 brackets of 2026
 * partition their pools with zero orphans and zero overlaps, and every game's two slots
 * are accounted for by either an entering team or a feeder winner.
 *
 *   node scripts/test-playoff-graph.js
 */
const { assignBrackets, buildEdges, winnerOf } = require('../src/playoff-graph');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got  ${a}\n          want ${b}`); }
};

// A game: winner listed first for readability; `g(id, date, home, away, hs, as)`.
const g = (id, date, home, away, homeScore, awayScore) =>
  ({ id, date, home, away, homeScore, awayScore });

const rounds = asn => {
  const c = {};
  for (const a of asn.values()) c[`r${a.round}`] = (c[`r${a.round}`] || 0) + 1;
  return c;
};

// ── 1. balanced 4-team bracket: 2 semis feed 1 final ────────────────────────
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),
    g(2, '2026-05-01', 'c', 'd', 10, 5),
    g(3, '2026-05-08', 'a', 'c', 10, 5),
  ];
  const { assignment, orphans, overlaps } = assignBrackets(games, [{ key: 'k', finalGameId: 3 }]);
  eq('balanced 4-team: round histogram', rounds(assignment), { r0: 1, r1: 2 });
  eq('balanced 4-team: no orphans/overlaps', [orphans.length, overlaps.length], [0, 0]);
  eq('balanced 4-team: final has null advancesTo', assignment.get(3).advancesTo, null);
  eq('balanced 4-team: semi advances to the final by natural key',
     assignment.get(1).advancesTo, { date: '2026-05-08', slugs: ['a', 'c'] });
}

// ── 2. BYE: a team whose first game is round 1, not the deepest round ────────
// This is the shape the user's ruling anticipated ("byes falling out naturally") and
// the shape 4 of 6 real 2026 brackets actually have. `z` enters at the semifinal.
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),   // prelim — only these two play early
    g(2, '2026-05-08', 'a', 'z', 10, 5),   // semi: prelim winner vs the bye team
    g(3, '2026-05-08', 'c', 'd', 10, 5),   // semi
    g(4, '2026-05-15', 'a', 'c', 10, 5),   // final
  ];
  const { assignment, orphans } = assignBrackets(games, [{ key: 'k', finalGameId: 4 }]);
  eq('bye: round histogram is UNBALANCED', rounds(assignment), { r0: 1, r1: 2, r2: 1 });
  eq('bye: no orphan', orphans.length, 0);
  // Nothing represents the bye itself. `z`'s absence from round 2 IS the bye — that is
  // the whole reason no placeholder game is emitted.
  eq('bye: no placeholder game invented', assignment.size, 4);
}

// ── 3. a TIE cannot advance anyone, so it produces no edge ──────────────────
{
  const tied = g(1, '2026-05-01', 'a', 'b', 7, 7);
  eq('tie: winnerOf is null', winnerOf(tied), null);
  eq('tie: no edge', [...buildEdges([tied, g(2, '2026-05-08', 'a', 'c', 10, 5)]).nextOf], []);
}

// ── 4. an unscored game produces no edge (the live-bracket limitation) ──────
{
  const unscored = g(1, '2026-05-01', 'a', 'b', null, null);
  eq('unscored: winnerOf is null', winnerOf(unscored), null);
  eq('unscored: no edge', [...buildEdges([unscored]).nextOf], []);
}

// ── 5. a game in NO bracket's pool is unassigned but NOT an orphan ──────────
// This is the endpoint's real case: a WA request carries games from divisions that have
// no declared bracket, and a cross-border game appears because one side is in-state.
// Neither is a partition failure, and neither may be reported as one.
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),
    g(2, '2026-05-08', 'a', 'c', 10, 5),
    g(9, '2026-05-08', 'out', 'sider', 3, 1),   // outside the pool entirely
  ];
  const { assignment, orphans } = assignBrackets(games,
    [{ key: 'k', finalGameId: 2, pool: x => x.id !== 9 }]);
  eq('out-of-pool: unassigned', assignment.has(9), false);
  eq('out-of-pool: NOT counted as an orphan', orphans.length, 0);
}

// ── 6. a game INSIDE a pool that the final cannot reach IS an orphan ────────
// The stop-and-report case: a real partition failure, which must never be smoothed over.
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),
    g(2, '2026-05-08', 'a', 'c', 10, 5),
    g(3, '2026-05-08', 'y', 'z', 4, 2),   // in pool, unreachable from the final
  ];
  const { orphans } = assignBrackets(games, [{ key: 'k', finalGameId: 2 }]);
  eq('unreachable in-pool game IS an orphan', orphans.map(o => o.id), [3]);
}

// ── 7. two brackets claiming one game is reported, not silently overwritten ──
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),
    g(2, '2026-05-08', 'a', 'c', 10, 5),
  ];
  const { assignment, overlaps } = assignBrackets(games,
    [{ key: 'first', finalGameId: 2 }, { key: 'second', finalGameId: 2 }]);
  eq('overlap: reported', overlaps.length > 0, true);
  eq('overlap: FIRST claim wins, later one does not overwrite',
     assignment.get(2).bracketKey, 'first');
}

// ── 8. no brackets at all → nothing assigned, nothing reported broken ───────
{
  const { assignment, orphans, overlaps } = assignBrackets(
    [g(1, '2026-05-01', 'a', 'b', 10, 5)], []);
  eq('no brackets: nothing assigned', assignment.size, 0);
  eq('no brackets: no orphans (nothing was claimable)', [orphans.length, overlaps.length], [0, 0]);
}

// ── 9. orientation cannot matter: advancesTo slugs are sorted ───────────────
{
  const games = [
    g(1, '2026-05-01', 'zebra', 'b', 10, 5),
    g(2, '2026-05-08', 'zebra', 'alpha', 10, 5),   // winner listed HOME
  ];
  const a1 = assignBrackets(games, [{ key: 'k', finalGameId: 2 }]).assignment.get(1);
  const flipped = [games[0], { ...games[1], home: 'alpha', away: 'zebra', homeScore: 5, awayScore: 10 }];
  const a2 = assignBrackets(flipped, [{ key: 'k', finalGameId: 2 }]).assignment.get(1);
  eq('advancesTo is orientation-independent', a1.advancesTo, a2.advancesTo);
  eq('advancesTo slugs are sorted', a1.advancesTo.slugs, ['alpha', 'zebra']);
}

// ── 10. THE INVARIANT depth rests on: at most one outgoing edge per game ────
// A winner has exactly one next appearance, so the reachable set is an in-tree and each
// game has a single path to the final. This is why traversal order cannot change `round`
// — swapping BFS for DFS altered nothing, which is a property of the graph, not luck.
// Assert the property directly, so a future change that let a game feed two games (a
// consolation edge, a double-elimination bracket) fails HERE rather than silently making
// `round` depend on queue discipline.
{
  const games = [
    g(1, '2026-05-01', 'a', 'b', 10, 5),
    g(2, '2026-05-01', 'c', 'd', 10, 5),
    g(3, '2026-05-08', 'a', 'c', 10, 5),
    g(4, '2026-05-15', 'a', 'e', 10, 5),
  ];
  const { nextOf, feeders } = buildEdges(games);
  // nextOf is a Map keyed by game id, so "one edge per game" is structural. What could
  // break is a game appearing twice in some feeder list.
  const appearances = {};
  for (const list of feeders.values()) for (const id of list) appearances[id] = (appearances[id] || 0) + 1;
  eq('each game feeds at most one game', Object.values(appearances).filter(n => n > 1).length, 0);
  eq('every edge in nextOf is mirrored in exactly one feeder list',
     [...nextOf.keys()].sort(), Object.keys(appearances).map(Number).sort());
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
