/**
 * The two phases of the LaxNumbers game import: every roster first, then games. Moved
 * verbatim from scripts/import-laxnumbers-games.js, whose header explains the ordering
 * and the state-scoped lookups.
 *
 * ctx: { c, commit, season, states, rosterLocked: Set, ix: buildIndexes(…),
 *        fakeId, seenThisRun: Set, report: { perState, unresolved: Map } }
 */
const { getState, listStates } = require('../config/states');
const { norm, loose, indexRatedByNumber } = require('./resolve');
const { ratingsRows, teamGames, politeness } = require('./fetch');
const { createTeam, findExisting, decide, insertGame, applySet, logConflicts,
        upsertSourceRecord, pruneVanished } = require('./apply');
const { toPacific, teamZone, todayIn } = require('./time');

async function runPhases(ctx) {
  const { c, season: SEASON, states: STATES, rosterLocked: ROSTER_LOCKED, report } = ctx;
  const { teamState, candStrict, candLoose, resolveRated, resolveOpponentGame, byId } = ctx.ix;
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
  const { http, counter } = ctx;
  // Phase 1 can create rated in-state teams (unlocked states), so on commit it is one
  // transaction of its own, ahead of the per-state game transactions.
  if (ctx.commit) await c.beginTransaction();
  for (const [i, code] of STATES.entries()) {
    const state = getState(code);
    if (!state) throw new Error(`unknown state ${code}`);
    if (i) await politeness(http);
    const rows = await ratingsRows(state, SEASON, http, counter);
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

  // EVERY OTHER FEED, for the opponent lookup only: an opponent link names a team number,
  // and the number may belong to any covered state, Oregon included. No roster work and
  // nothing created from these; one request each.
  for (const st of listStates()) {
    if (!st.laxnumbersId || ratings.has(st.code)) continue;
    await politeness(http);
    const rows = await ratingsRows(st, SEASON, http, counter);
    ratings.set(st.code, rows);
    console.log(`  ${st.code}: ratings fetched for the opponent lookup only — ${rows.length} rated team(s)`);
  }
  if (ctx.commit) await c.commit();
  const byNbr = indexRatedByNumber(ratings);

  // ══ PHASE 2a: every team page, before any game is written. ══
  // A failed request stops the run here, with nothing written for any state.
  const pagesByState = new Map();
  for (const code of STATES) {
    const state = getState(code);
    const pages = { ok: 0, firstRay: null, lastRay: null };
    const list = [];
    for (const t of ratings.get(code)) {
      await politeness(http);
      list.push({ t, games: await teamGames(state, t.team_nbr, SEASON, pages, http, counter) });
    }
    pagesByState.set(code, { list, pages });
    console.log(`[LaxNumbers:${code}] ${pages.replayed ? `${pages.replayed} team page(s) REPLAYED from ${http.dir}`
      : `${pages.ok} team page(s) 200` + (pages.ok ? `, cf-ray ${pages.firstRay} … ${pages.lastRay}` : '')}`);
  }

  // ══ PHASE 2b: games, one transaction per state. ══
  const feedKeys = new Set();        // every resolved game LaxNumbers lists, for the prune
  const readTeams = new Set();       // teams whose page was read and fully resolved
  const teamOf = id => ({ slug: byId.get(id)?.slug ?? null, state: teamState.get(id) ?? null });

  for (const code of STATES) {
    const state = getState(code);
    const { list } = pagesByState.get(code);
    const today = todayIn(state.timeZone);
    const locked = ROSTER_LOCKED.has(code);
    const st = { teams: list.length, gpTotal: 0, parsed: 0, resolved: 0, unresolved: 0,
                 noResult: 0, scheduled: 0, ot: 0, ff: 0, mirrored: 0, ruledOut: 0, oregon: 0,
                 inserted: 0, updated: 0, filled: 0, unchanged: 0,
                 conflictGames: 0, conflictFields: 0, flipped: 0,
                 time: { stored: 0, 'no-time': 0, 'no-zone': 0, unreadable: 0, nonexistent: 0, 'other-day': 0 },
                 oppByNumber: 0, oppByName: 0, oppNoLink: 0, oppNotInFeeds: 0,
                 matchedBySource: {}, samples: { conflict: [], flipped: [], update: [], fill: [] } };
    const sample = (k, line) => { if (st.samples[k].length < 25) st.samples[k].push(line); };

    if (ctx.commit) await c.beginTransaction();
    try {
      for (const { t, games } of list) {
        st.gpTotal += t.gp || 0;
        // The rated team itself must exist in OUR roster; if it does not, that is an
        // unresolved ROSTER entry, reported the same way and never invented. Locked or
        // not, the same both-states rule as phase 1.
        const selfR = resolveRated(t, code);
        const selfId = selfR.id;
        st.parsed += games.length;
        let pageClean = selfId != null && selfId > 0;

        for (const g of games) {
          if (g.isOvertime) st.ot++;
          if (g.isForfeit) st.ff++;
          // "-" means scheduled, cancelled or never played. Today or later in the state's
          // zone it is a fixture (flag 4); earlier, there is nothing to import.
          const isFixture = g.teamScore === null;
          if (isFixture && g.date < today) { st.noResult++; continue; }

          // BY TEAM NUMBER FIRST (resolve.js resolveOpponentGame); the name only for an
          // unlinked opponent or a number in none of our feeds. A refusal is final.
          const oppR = resolveOpponentGame(g, code, byNbr);
          const oppId = oppR.id;
          if (oppR.by === 'number') st.oppByNumber++;
          else { st.oppByName++; if (oppR.nameWhy === 'no-link') st.oppNoLink++; else st.oppNotInFeeds++; }

          // NO PLACEHOLDERS (flag 1, 2026-11-14). An opponent we cannot resolve is logged
          // to unresolved_aliases with the game as context, and the game waits for a
          // ruling. The next pass after the ruling imports it.
          if (!selfId || !oppId) {
            st.unresolved++; pageClean = false;
            const raw = !selfId ? t.name : g.opponentRaw;
            const key = `${code}|${raw}`;
            const e = report.unresolved.get(key) ?? { state: code, raw, count: 0, samples: [] };
            e.count++;
            const why = !selfId ? selfR : oppR;
            if (why.reason === 'ambiguous') e.ambiguous = why.candidates.map(label).join(' | ');
            if (why.reason === 'foreign-unruled') e.foreign = `tagged ${why.rowState}; matches ${why.candidates.map(label).join(' | ')} only through the feed state`;
            if (selfId && oppR.by === 'number') e.number = `t=${oppR.nbr} is "${oppR.ratedName}" in ${oppR.feed}'s feed — ${oppR.reason}; the name was not tried`;
            if (e.samples.length < 2) e.samples.push(`${g.date} ${t.name} ${g.teamScore ?? '-'}-${g.oppScore ?? '-'} ${g.opponentRaw}`);
            report.unresolved.set(key, e);
            continue;
          }
          st.resolved++;

          const [homeId, awayId] = g.isHome ? [selfId, oppId] : [oppId, selfId];
          const lo = Math.min(homeId, awayId), hi = Math.max(homeId, awayId);
          const runKey = `${g.date}|${lo}|${hi}`;
          feedKeys.add(runKey);
          if (ctx.seenThisRun.has(runKey)) { st.mirrored++; continue; }
          ctx.seenThisRun.add(runKey);
          const tag = `${g.date} ${label(homeId)} v ${label(awayId)}`;

          // RULED OUT — never imported, whatever the database holds.
          const ruling = ctx.ix.ruledOut(SEASON, g.date, homeId, awayId);
          if (ruling) {
            st.ruledOut++;
            console.log(`      ruled out: ${tag} ${g.isHome ? g.teamScore : g.oppScore}-${g.isHome ? g.oppScore : g.teamScore}` +
                        ` — ruling ${ruling.ruling}, not imported`);
            continue;
          }
          // OREGON IS OHSLA'S (flag 5). Nothing written for a game with an Oregon side:
          // not an insert, not a fill, not a source row.
          if (teamState.get(homeId) === 'OR' || teamState.get(awayId) === 'OR') { st.oregon++; continue; }

          // The time, read in the HOME team's zone, stored as Pacific wall-clock.
          const tp = toPacific(g.date, g.time, teamZone(teamOf(homeId), ctx.zoneOverrides));
          let dt = tp.value;
          // A Pacific time on another day than game_date would put dateKey and datetime
          // on different days. Not stored; expected never (a Mountain game before 1 AM).
          if (dt && dt.slice(0, 10) !== g.date) { st.time['other-day']++; dt = null; }
          else if (dt) st.time.stored++; else st.time[tp.why]++;

          const inc = {
            homeId, awayId, dt,
            homeScore: isFixture ? null : (g.isHome ? g.teamScore : g.oppScore),
            awayScore: isFixture ? null : (g.isHome ? g.oppScore : g.teamScore),
            isOvertime: !isFixture && g.isOvertime, isForfeit: !isFixture && g.isForfeit,
            status: isFixture ? 'scheduled' : 'completed',
          };
          if (isFixture) st.scheduled++;
          const existing = (homeId < 0 || awayId < 0) ? null : await findExisting(c, SEASON, g.date, lo, hi);
          if (existing) {
            const src = existing.canonical_source ?? 'null';
            st.matchedBySource[src] = (st.matchedBySource[src] ?? 0) + 1;
          }
          const d = decide(inc, existing);
          const names = { home: g.isHome ? t.name : g.opponentRaw, away: g.isHome ? g.opponentRaw : t.name };
          if (d.flipped) { st.flipped++; sample('flipped', `${tag}: row has home ${label(existing.home_team_id)}, LaxNumbers says ${label(homeId)}`); }
          if (d.conflicts.length) {
            st.conflictGames++; st.conflictFields += d.conflicts.length;
            for (const x of d.conflicts) sample('conflict', `#${existing.id} ${tag} ${x.field}: ${x.owner} ${x.owner_value} vs laxnumbers ${x.other_value}`);
          }
          const setText = () => Object.entries(d.set).map(([k, v]) => `${k}=${v}`).join(' ');

          if (d.action === 'insert') st.inserted++;
          if (d.action === 'update') { st.updated++; sample('update', `#${existing.id} ${tag}: ${setText()}`); }
          if (d.action === 'fill') { st.filled++; sample('fill', `#${existing.id} ${tag} (${existing.canonical_source}): ${setText()}`); }
          if (d.action === 'none') st.unchanged++;
          if (!ctx.commit) continue;

          const gameId = d.action === 'insert' ? await insertGame(c, SEASON, g.date, inc) : existing.id;
          if (d.action === 'update' || d.action === 'fill') await applySet(c, gameId, d.set, d.action === 'fill');
          await logConflicts(c, gameId, d.conflicts);
          await upsertSourceRecord(c, gameId, g.date, inc, names);
        }
        if (pageClean) readTeams.add(selfId);
      }
      if (ctx.commit) await c.commit();
    } catch (err) {
      if (ctx.commit) await c.rollback();
      throw err;
    }

    report.perState[code] = st;
    console.log(`  ${code}: ${st.teams} rated teams, gp total ${st.gpTotal}, parsed ${st.parsed}`);
    console.log(`      resolved ${st.resolved}  unresolved ${st.unresolved}  ruled-out ${st.ruledOut}  oregon-skipped ${st.oregon}`);
    console.log(`      ${ctx.commit ? '' : 'would: '}insert ${st.inserted} (scheduled ${st.scheduled})  update ${st.updated}  ` +
                `fill ${st.filled}  unchanged ${st.unchanged}`);
    console.log(`      conflicts ${st.conflictFields} field(s) on ${st.conflictGames} game(s)  home/away disagreements ${st.flipped}`);
    console.log(`      times: stored ${st.time.stored}  blank ${st.time['no-time']}  zone unknown ${st.time['no-zone']}  ` +
                `unreadable ${st.time.unreadable}  nonexistent ${st.time.nonexistent}  other Pacific day ${st.time['other-day']}`);
    console.log(`      OT ${st.ot}  forfeits ${st.ff}  no-result (past "-") ${st.noResult}`);
    console.log(`      opponents by team number ${st.oppByNumber}, by name ${st.oppByName} ` +
                `(no link ${st.oppNoLink}, number in no feed ${st.oppNotInFeeds})`);
    const by = Object.entries(st.matchedBySource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
    console.log(`      existing rows by canonical_source: ${by}`);
    for (const [k, title] of [['conflict', 'conflict'],
                              ['flipped', 'home/away'], ['fill', 'fill'], ['update', 'update']]) {
      const n = { conflict: st.conflictFields, flipped: st.flipped, fill: st.filled, update: st.updated }[k];
      st.samples[k].forEach(l => console.log(`        ${title}: ${l}`));
      if (n > st.samples[k].length) console.log(`        … ${n - st.samples[k].length} more ${title} line(s)`);
    }
    if (locked) console.log(`      (roster locked: matched only, nothing created)`);
  }

  // ══ AFTER THE WRITES: vanished fixtures, stale marking. ══
  const pr = await pruneVanished(c, SEASON, readTeams, feedKeys, ctx.commit);
  if (pr.refused) console.log(`  PRUNE REFUSED: ${pr.candidates} vanished fixture(s) vs ${feedKeys.size} feed games — feed looks partial`);
  else console.log(`  prune: ${ctx.commit ? '' : 'would remove '}${pr.pruned.length} laxnumbers fixture(s) no longer listed` +
                   (pr.pruned.length ? `: ${pr.pruned.map(x => `#${x.id} ${x.d}`).join(', ')}` : ''));
  report.pruned = pr;
}

module.exports = { runPhases };
