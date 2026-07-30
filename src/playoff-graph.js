/**
 * The playoff game graph: partition, round, and winner-advancement edges.
 *
 * ONE DERIVATION SITE. Both `scripts/seed-playoff-formats.js` and the
 * `/schedule/playoffs` endpoint call this. Two implementations of the same walk would
 * drift, and this codebase has already paid that bill: the orientation-sensitive
 * dedup key existed in three places and was fixed in only two, and the client's
 * `buildBrackets` reconstructed a field from rankings while the server had the real one.
 *
 * WHAT THE SERVER SHIPS, so the client derives nothing:
 *   bracketKey  which bracket a game belongs to
 *   round       reachability depth from the final: 0 = final, 1 = semifinal, ...
 *   advancesTo  a NATURAL reference to the game the winner plays next, null for finals
 *
 * `advancesTo` is a natural reference — {date, slugs:[lo,hi]} — never a bare game id,
 * for the same reason format anchors are: ids are environment-local and
 * re-import-mutable. Staging's ids already differ from prod's, the mirrored-game dedupe
 * deleted six, and the v1→v2 backfill renumbered everything.
 *
 * TEAM IDENTITY IS THE SLUG, not the numeric team id. Same reasoning, and it is what
 * both callers already have: GAME_SELECT joins teams for the slug and never selects
 * `home_team_id` at all.
 *
 * BYES ARE NEVER DRAWN and never need to be: a team whose first appearance is round 2
 * simply has no round-3 game. The absence IS the bye. Nothing here emits a placeholder.
 *
 * ROUND COUNTS BACKWARD from the final on purpose. Depth from the anchor is the only
 * number this graph actually knows. "Round 1 of 5" requires knowing the bracket's total
 * depth, which is a property of the FORMAT (field_size), not of any single game — so it
 * belongs to the client's layout pass, which has the format in hand. Emitting a
 * forward-counted round here would mean guessing the depth per game and getting play-in
 * games wrong in exactly the cases play-in games exist for.
 *
 * LIMITATION, deliberate: edges are followed through WINNERS, so a game needs a score
 * for its edge to exist. This assembles a finished bracket, not a live one. Mid-season
 * the shape still comes from `playoff_formats` and cells fill as results land; wiring
 * the live case is a March 2027 problem, tracked, not today's.
 */

/** The advancing team's slug. A tie cannot advance anyone, so it yields null. */
const winnerOf = g =>
  g.homeScore == null || g.awayScore == null || g.homeScore === g.awayScore
    ? null
    : (g.homeScore > g.awayScore ? g.home : g.away);

/**
 * Winner-advancement edges over a pool of playoff games.
 *
 * @param {Array} games  [{id, date:'YYYY-MM-DD', home, away, homeScore, awayScore}]
 *                       `home`/`away` are team slugs.
 * @returns {{feeders: Map<any, any[]>, nextOf: Map<any, any>}}
 */
function buildEdges(games) {
  const ordered = [...games].sort((p, q) =>
    p.date < q.date ? -1 : p.date > q.date ? 1 : (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const feeders = new Map();
  const nextOf = new Map();
  for (const g of ordered) {
    const w = winnerOf(g);
    if (!w) continue;                       // no winner, no edge
    // The winner's NEXT playoff appearance in this pool is the game this one feeds.
    const next = ordered.find(y => y.date > g.date && (y.home === w || y.away === w));
    if (!next) continue;
    nextOf.set(g.id, next.id);
    if (!feeders.has(next.id)) feeders.set(next.id, []);
    feeders.get(next.id).push(g.id);
  }
  return { feeders, nextOf };
}

/**
 * Games reachable backward from `finalId`, mapped to their depth from it.
 *
 * DEPTH IS UNAMBIGUOUS, and not because this walk is breadth-first. A winner has exactly
 * one next appearance, so `nextOf` is a function — every game has at most ONE outgoing
 * edge — which makes the reachable set an in-tree and gives every game a single path to
 * the final. Traversal order cannot change the answer. (Confirmed the hard way: swapping
 * this BFS for a DFS changes no result, on fixtures or on all six real 2026 brackets.)
 * The single-outgoing-edge invariant is asserted in scripts/test-playoff-graph.js,
 * because it — not the queue discipline — is what the correctness rests on.
 */
function reachableWithDepth(feeders, finalId) {
  const depth = new Map([[finalId, 0]]);
  const queue = [finalId];
  while (queue.length) {
    const id = queue.shift();
    for (const p of feeders.get(id) || []) {
      if (!depth.has(p)) { depth.set(p, depth.get(id) + 1); queue.push(p); }
    }
  }
  return depth;
}

/**
 * Assign each game to a bracket, with its round and advancement edge.
 *
 * @param {Array} games     all playoff games in scope (shape as buildEdges)
 * @param {Array} brackets  [{key, finalGameId, pool?}] — `pool` is a predicate
 *                          narrowing which games this bracket may claim. Washington's
 *                          brackets are division-scoped; Oregon's two share one
 *                          statewide pool, which is exactly why Championship
 *                          first-round losers can flow into the Cascade Cup.
 * @returns {{assignment: Map, orphans: Array, overlaps: Array}}
 */
function assignBrackets(games, brackets) {
  const byId = new Map(games.map(g => [g.id, g]));
  const assignment = new Map();
  const overlaps = [];
  const claimable = new Set();

  for (const b of brackets) {
    const pool = b.pool ? games.filter(b.pool) : games;
    pool.forEach(g => claimable.add(g.id));
    const { feeders, nextOf } = buildEdges(pool);
    const depths = reachableWithDepth(feeders, b.finalGameId);
    for (const [id, round] of depths) {
      const prior = assignment.get(id);
      if (prior && prior.bracketKey !== b.key) {
        overlaps.push({ id, claimedBy: [prior.bracketKey, b.key] });
        continue;
      }
      const next = byId.get(nextOf.get(id));
      assignment.set(id, {
        bracketKey: b.key,
        round,
        // Sorted, so orientation cannot matter — the shape format anchors use.
        advancesTo: next
          ? { date: next.date, slugs: [next.home, next.away].sort() }
          : null,
      });
    }
  }

  // Orphans are judged against the union of the bracket POOLS, not every game handed
  // in: a WA request also carries games from divisions that have no bracket, and those
  // are legitimately unassigned rather than a partition failure.
  const orphans = games.filter(g => claimable.has(g.id) && !assignment.has(g.id));
  return { assignment, orphans, overlaps };
}

module.exports = { buildEdges, reachableWithDepth, assignBrackets, winnerOf };
