/**
 * The two phases of the LaxNumbers game import: every roster first, then games. Moved
 * verbatim from scripts/import-laxnumbers-games.js, whose header explains the ordering
 * and the state-scoped lookups.
 *
 * ctx: { c, commit, season, states, rosterLocked: Set, ix: buildIndexes(…),
 *        fakeId, seenThisRun: Set, report: { perState, unresolved: Map } }
 */
const { getState } = require('../config/states');
const { norm, loose, RULINGS } = require('./resolve');
const { ratingsRows, teamGames, politeness } = require('./fetch');
const { createTeam, insertGame } = require('./apply');

async function runPhases(ctx) {
  const { c, season: SEASON, states: STATES, rosterLocked: ROSTER_LOCKED, report } = ctx;
  const { idx, looseIdx, teamState, stateIdx, stateLooseIdx,
          stateAliasIdx, stateAliasLooseIdx, lockedSelfId } = ctx.ix;

  // ══ PHASE 1, ALL STATES FIRST. Rosters before any games, without exception. ══
  //
  // Interleaving them is an ORDERING TRAP, and it bit: with roster-then-games per
  // state, Idaho's GAMES ran before Nevada's ROSTER, so "Bishop Manogue" — a Reno
  // school Nevada rates — was first seen as an Idaho opponent and became a stateless
  // placeholder. Nevada's roster phase then found the name already indexed and skipped
  // it, so the placeholder ABSORBED the identity: one row, no duplicate, and the wrong
  // state. Eight teams landed that way, invisible to /teams?state=NV despite being
  // Nevada teams.
  //
  // Every roster first means a placeholder can only ever be created for a name no
  // state's rated list contains — which is what "unresolved" was supposed to mean.
  const ratings = new Map();
  for (const code of STATES) {
    const state = getState(code);
    if (!state) throw new Error(`unknown state ${code}`);
    const rows = await ratingsRows(state, SEASON);
    ratings.set(code, rows);

    // LOCKED: match only, in the feed's state then the row's tagged state (see
    // lockedSelfId). Never another state's same-named school.
    // Unmatched rows are counted here and reported per game in phase 2.
    if (ROSTER_LOCKED.has(code)) {
      let matched = 0;
      for (const t of rows) {
        if (lockedSelfId(t, code) != null) matched++;
        else console.log(`      not in roster: "${t.name}" (${t.state || code}) — unresolved, not created`);
      }
      console.log(`  ${code}: roster LOCKED — matched ${matched} of ${rows.length} rated team(s), created 0`);
      continue;
    }

    let created = 0;
    for (const t of rows) {
      // STATE-SCOPED. A global hit on another state's team is a COLLISION, not a match.
      const candidate = idx.get(norm(t.name)) ?? looseIdx.get(loose(t.name)) ?? null;
      const cs = candidate != null ? (teamState.get(candidate) ?? null) : undefined;
      const have = candidate != null && (cs === code || cs === null) ? candidate : null;
      if (candidate != null && !have) {
        console.log(`      collision: "${t.name}" exists in ${cs} — creating a separate ${code} team`);
      }
      if (have) continue;
      await createTeam(ctx, t.name, code, state.slugSuffix, 'rated in-state team');
      created++;
    }
    console.log(`  ${code}: roster — created ${created} team(s) from the rated list`);
  }

  // ══ PHASE 2: games, with every roster already in place. ══
  for (const code of STATES) {
    const state = getState(code);
    const rows = ratings.get(code);
    const locked = ROSTER_LOCKED.has(code);
    const st = { teams: rows.length, gpTotal: 0, parsed: 0, resolved: 0, unresolved: 0,
                 matchedExisting: 0, wouldInsert: 0, ot: 0, ff: 0, noResult: 0,
                 placeholders: 0, gpFromSource: 0, mirrored: 0, ruled: 0, untagged: 0,
                 matchedBySource: {} };

    for (const t of rows) {
      st.gpTotal += t.gp || 0;
      // The rated team itself must exist in OUR roster; if it does not, that is an
      // unresolved ROSTER entry, reported the same way and never invented.
      const selfId = locked ? lockedSelfId(t, code)
                            : idx.get(norm(t.name)) ?? looseIdx.get(loose(t.name)) ?? null;
      const games = await teamGames(state, t.team_nbr, SEASON);
      st.parsed += games.length;

      for (const g of games) {
        if (g.isOvertime) st.ot++;
        if (g.isForfeit) st.ff++;
        if (g.teamScore === null) { st.noResult++; continue; }   // nothing to import

        // SAME STATE FIRST. An opponent on state X's page is usually in X, and two
        // states can share a school name — resolving globally is how Idaho's Mountain
        // View became Washington's. A genuine cross-border opponent still resolves,
        // via the fallback.
        //
        // LOCKED states also try their own curated aliases before the global fallback: a
        // display rename ("Mountain View" → "Mountain View (WA)") leaves the old name only
        // as an alias, and without this step Camas/Skyview/Woodland's "Mountain View"
        // fell through to Idaho's.
        let oppId = stateIdx.get(code)?.get(norm(g.opponentRaw))
                 ?? stateLooseIdx.get(code)?.get(loose(g.opponentRaw))
                 ?? (locked ? stateAliasIdx.get(code)?.get(norm(g.opponentRaw))
                           ?? stateAliasLooseIdx.get(code)?.get(loose(g.opponentRaw)) : null)
                 ?? idx.get(norm(g.opponentRaw))
                 ?? looseIdx.get(loose(g.opponentRaw)) ?? null;

        // PLACEHOLDER WITH PROVENANCE. An opponent outside our coverage still played a
        // real game against a team we are importing, and dropping it would hide a real
        // result from the season we are importing to show. It becomes a team with NO
        // STATE — LaxNumbers publishes no state for an opponent string, and inventing
        // one would be the guess this rule exists to forbid. A stateless team renders
        // as a plain opponent name with no out-of-state tag, which is honest: we know
        // who they played, not where they are from.
        // LOCKED states never create one: the opponent falls through to unresolved.
        if (selfId && !oppId && !locked) {
          // A RULED origin, or NULL. Never a guess — see data/placeholder-states.json.
          const ruling = RULINGS.get(norm(g.opponentRaw)) || null;
          oppId = await createTeam(ctx, g.opponentRaw, ruling ? ruling.state : null, null,
                                   'unresolved opponent');
          st.placeholders++;
          if (ruling) st.ruled++; else st.untagged++;
        }
        if (!selfId || !oppId) {
          st.unresolved++;
          const raw = !selfId ? t.name : g.opponentRaw;
          const key = `${code}|${raw}`;
          const e = report.unresolved.get(key) ?? { state: code, raw, count: 0, samples: [] };
          e.count++;
          if (e.samples.length < 2) e.samples.push(`${g.date} ${t.name} ${g.teamScore}-${g.oppScore} ${g.opponentRaw}`);
          report.unresolved.set(key, e);
          continue;
        }
        st.resolved++;

        const [homeId, awayId] = g.isHome ? [selfId, oppId] : [oppId, selfId];
        const lo = Math.min(homeId, awayId), hi = Math.max(homeId, awayId);
        const runKey = `${g.date}|${lo}|${hi}`;
        if (ctx.seenThisRun.has(runKey)) { st.mirrored++; continue; }
        ctx.seenThisRun.add(runKey);

        const [[existing]] = (homeId < 0 || awayId < 0) ? [[null]] : await c.execute(
          `SELECT id, canonical_source FROM games
            WHERE season = ? AND game_date = ?
              AND LEAST(home_team_id, away_team_id) = ?
              AND GREATEST(home_team_id, away_team_id) = ? LIMIT 1`,
          [SEASON, g.date, lo, hi]);
        if (existing) {                                          // cross-border row already ours
          st.matchedExisting++;
          const src = existing.canonical_source ?? 'null';
          st.matchedBySource[src] = (st.matchedBySource[src] ?? 0) + 1;
          continue;
        }
        st.wouldInsert++;

        if (ctx.commit) await insertGame(c, SEASON, g, homeId, awayId);
      }
      await politeness();
    }
    report.perState[code] = st;
    console.log(`  ${code}: ${st.teams} rated teams, gp total ${st.gpTotal}, parsed ${st.parsed}`);
    console.log(`      resolved ${st.resolved}  unresolved ${st.unresolved}  ` +
                `matched-existing ${st.matchedExisting}  would-insert ${st.wouldInsert}`);
    console.log(`      OT ${st.ot}  forfeits ${st.ff}  no-result ${st.noResult}`);
    // Locked states only, so an unlocked state's report is unchanged line for line.
    if (locked) {
      const by = Object.entries(st.matchedBySource).sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
      console.log(`      matched-existing by canonical_source: ${by}`);
    }
  }
}

module.exports = { runPhases };
