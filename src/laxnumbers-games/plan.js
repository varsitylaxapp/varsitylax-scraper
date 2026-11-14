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
  const { teamState, candStrict, candLoose, resolveRated, resolveOpponent, byId } = ctx.ix;
  const label = id => { const t = byId.get(id); return t ? `${t.state ?? '-'}:${t.slug}` : `new#${id}`; };
  // Every rated row LaxNumbers tags with ANOTHER state, and where it went. The both-states
  // rule can attach such a row to a same-named school in the feed's state; listing every
  // one is how a human sees whether that was Hermiston (right) or a guess (wrong).
  const foreign = (t, code, r) => {
    if (!r.rowState || r.rowState === code) return;
    const to = r.id != null ? `${label(r.id)} (via ${r.via === 'row' ? 'its tagged state' : 'the FEED state, ruled'})`
             : r.reason === 'ambiguous' ? `AMBIGUOUS ${r.candidates.map(label).join(' | ')}`
             : r.reason === 'foreign-unruled' ? `REFUSED: matches ${r.candidates.map(label).join(' | ')} only through the feed state, and no ruling lists it`
             : 'not in roster';
    console.log(`      foreign row: "${t.name}" tagged ${r.rowState} in ${code}'s feed → ${to}`);
  };

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
  for (const slug of ctx.ix.staleForeignRulings) {
    console.log(`  WARNING: data/foreign-row-rulings.json names team "${slug}", which does not exist`);
  }
  // A ruling that cannot match protects nothing. The script makes it fatal
  // (strictRulings); the cron will warn and carry on.
  for (const g of ctx.ix.staleRuledOut) {
    const msg = `data/ruled-out-games.json: "${g}" names a team that does not exist`;
    if (ctx.strictRulings) throw new Error(msg);
    console.log(`  WARNING: ${msg}`);
  }
  const ratings = new Map();
  for (const code of STATES) {
    const state = getState(code);
    if (!state) throw new Error(`unknown state ${code}`);
    const rows = await ratingsRows(state, SEASON);
    ratings.set(code, rows);

    // LOCKED: match only, by the both-states rule (resolve.js resolveRated). Never
    // another state's same-named school.
    // Unmatched rows are counted here and reported per game in phase 2.
    if (ROSTER_LOCKED.has(code)) {
      let matched = 0;
      for (const t of rows) {
        const r = resolveRated(t, code);
        foreign(t, code, r);
        if (r.id != null) matched++;
        else if (r.reason === 'ambiguous') console.log(`      ambiguous: "${t.name}" (${t.state || code}) → ${r.candidates.map(label).join(' | ')} — unresolved, not created`);
        else console.log(`      not in roster: "${t.name}" (${t.state || code}) — unresolved, not created`);
      }
      console.log(`  ${code}: roster LOCKED — matched ${matched} of ${rows.length} rated team(s), created 0`);
      continue;
    }

    let created = 0;
    for (const t of rows) {
      // STATE-SCOPED, by the both-states rule. No stateless match: a stateless
      // placeholder answering to a rated team's name is how Bishop Manogue's identity
      // was absorbed.
      const r = resolveRated(t, code);
      foreign(t, code, r);
      if (r.id != null) continue;
      if (r.reason === 'ambiguous') {
        console.log(`      ambiguous: "${t.name}" (${t.state || code}) → ${r.candidates.map(label).join(' | ')} — not created`);
        continue;
      }
      // A row tagged with ANOTHER state is that state's team. It is never created as
      // this feed's — that is finding 1, Idaho's feed listing WA/MT/WY schools.
      if (r.rowState && r.rowState !== code) continue;   // already listed by foreign()
      const elsewhere = [...(candStrict.get(norm(t.name)) ?? candLoose.get(loose(t.name)) ?? [])]
        .map(id => teamState.get(id) ?? null).filter(st => st !== code);
      if (elsewhere.length) {
        console.log(`      collision: "${t.name}" exists in ${[...new Set(elsewhere)].join(', ')} — creating a separate ${code} team`);
      }
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
                 placeholders: 0, gpFromSource: 0, mirrored: 0, ruled: 0, untagged: 0, ruledOut: 0,
                 matchedBySource: {} };
    const pages = { ok: 0, firstRay: null, lastRay: null };

    for (const t of rows) {
      st.gpTotal += t.gp || 0;
      // The rated team itself must exist in OUR roster; if it does not, that is an
      // unresolved ROSTER entry, reported the same way and never invented. Locked or not,
      // the same both-states rule as phase 1 (finding 2: this was a GLOBAL lookup for
      // unlocked states).
      const selfR = resolveRated(t, code);
      const selfId = selfR.id;
      const games = await teamGames(state, t.team_nbr, SEASON, pages);
      st.parsed += games.length;

      for (const g of games) {
        if (g.isOvertime) st.ot++;
        if (g.isForfeit) st.ff++;
        if (g.teamScore === null) { st.noResult++; continue; }   // nothing to import

        // SAME STATE FIRST — teams, then curated aliases (a display rename like
        // "Mountain View" → "Mountain View (WA)" leaves the old name only as an alias).
        // Then the whole roster ONLY if exactly one team answers to the name (finding 3:
        // this was a last-wins global lookup, which is how Idaho's Mountain View became
        // Washington's). Several → refused as ambiguous, never picked.
        const oppR = resolveOpponent(g.opponentRaw, code);
        let oppId = oppR.id;

        // PLACEHOLDER WITH PROVENANCE. An opponent outside our coverage still played a
        // real game against a team we are importing, and dropping it would hide a real
        // result from the season we are importing to show. It becomes a team with NO
        // STATE — LaxNumbers publishes no state for an opponent string, and inventing
        // one would be the guess this rule exists to forbid. A stateless team renders
        // as a plain opponent name with no out-of-state tag, which is honest: we know
        // who they played, not where they are from.
        // LOCKED states never create one: the opponent falls through to unresolved.
        if (selfId && !oppId && !locked && oppR.reason === 'unknown') {
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
          const why = !selfId ? selfR : oppR;
          if (why.reason === 'ambiguous') e.ambiguous = why.candidates.map(label).join(' | ');
          if (why.reason === 'foreign-unruled') e.foreign = `tagged ${why.rowState}; matches ${why.candidates.map(label).join(' | ')} only through the feed state`;
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

        // RULED OUT — never imported, whatever the database holds. Checked before the
        // existence lookup so the ruling is reported even if someone re-created the row.
        const ruling = ctx.ix.ruledOut(SEASON, g.date, homeId, awayId);
        if (ruling) {
          st.ruledOut++;
          console.log(`      ruled out: ${g.date} ${label(homeId)} v ${label(awayId)} ` +
                      `${g.isHome ? g.teamScore : g.oppScore}-${g.isHome ? g.oppScore : g.teamScore}` +
                      ` — ruling ${ruling.ruling}, not imported`);
          continue;
        }

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
    console.log(`[LaxNumbers:${code}] ${pages.ok} team page(s) 200` +
                (pages.ok ? `, cf-ray ${pages.firstRay} … ${pages.lastRay}` : ''));
    console.log(`  ${code}: ${st.teams} rated teams, gp total ${st.gpTotal}, parsed ${st.parsed}`);
    console.log(`      resolved ${st.resolved}  unresolved ${st.unresolved}  ` +
                `matched-existing ${st.matchedExisting}  would-insert ${st.wouldInsert}  ruled-out ${st.ruledOut}`);
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
