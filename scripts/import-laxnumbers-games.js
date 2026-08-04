#!/usr/bin/env node
/**
 * Import 2026 game results for the NON-CURATED states (AZ, ID, MT, NV) from LaxNumbers.
 *
 *   ./scripts/staging scripts/import-laxnumbers-games.js --state=ID
 *   ./scripts/staging scripts/import-laxnumbers-games.js --state=ID --commit
 *   node scripts/import-laxnumbers-games.js --state=ID --stage-c --commit     (prod)
 *
 * DRY RUN BY DEFAULT. Without --commit it fetches, resolves, and reports — including the
 * full unresolved-opponent list — and writes nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS DIFFERENT FROM EVERY OTHER IMPORTER HERE
 *
 * Oregon and Washington both arrived with human-curated identity: OHSLA names were
 * reconciled by hand, WHSBLA shipped `alias-decisions.json` carrying rulings. NEITHER
 * EXISTS FOR THESE FOUR STATES. An opponent string is whatever LaxNumbers calls that
 * school, and nobody has ever checked it against our roster.
 *
 * So the standing rule for non-curated sources applies in full:
 *
 *     PLACEHOLDERS WITH PROVENANCE. NEVER A SILENT DROP. NEVER A GUESS.
 *
 * An opponent that does not resolve is recorded in `unresolved_aliases` with its raw
 * name, source, state and the game that referenced it. It does NOT become a team, and
 * its game is NOT imported, until a human rules on it. A fuzzy match that is right 90%
 * of the time is how a kid ends up on the wrong roster.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROSTER SOURCES ALWAYS RUN BEFORE OPPONENT-DERIVED CREATION. GLOBALLY, NOT PER UNIT
 * OF WORK — AND ROSTER MATCHING IS STATE-SCOPED.
 *
 * The second half was learned separately and painfully. Idaho's rated list contains
 * "Mountain View". So does Oregon's, and so does Washington's — three different schools
 * sharing a name. A GLOBAL name lookup during Idaho's roster phase found Washington's,
 * decided Idaho's Mountain View already existed, and created nothing. Thirteen Idaho
 * games — every one against Boise-area opposition — were then written onto a Bellevue
 * team's season.
 *
 * Phase separation did not prevent it, because this is not an ordering problem: it is a
 * NAME COLLISION ACROSS STATES, and no amount of running rosters first can help when the
 * lookup itself ignores which state is being imported.
 *
 * So a rated team for state X matches only a team already in X, or a stateless
 * placeholder. Never a team belonging to another state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GENERAL RULE, of which both of the above are instances:
 *
 *     AN IDENTITY LOOKUP MUST BE EXACTLY AS NARROW AS THE THING BEING IMPORTED.
 *
 * A lookup wider than its subject silently merges two real entities, and NOTHING
 * DOWNSTREAM CAN TELL. The count ladder still closes at UNEXPLAINED 0 — every row is
 * accounted for. Source-conflict logging sees nothing — there is no conflict, one team
 * simply absorbed another's season. The payload diff reports additions only. Every
 * structural check passes, because structural checks verify that rows are EXPLAINED and
 * this class of defect leaves them perfectly explained.
 *
 * Only TRUTH-ANCHORED checks catch it: geographic coherence, external records, a human
 * reading a list. See scripts/check-geographic-coherence.js.
 *
 * Three members of the family so far, each one index too wide:
 *
 *   Brophy Prep / Brophy Prep II   two names, one school — a sweep would merge a JV
 *                                  squad into varsity. Caught by a human ruling.
 *   Bishop Manogue                 absorption by ORDERING — an opponent-derived
 *                                  placeholder claimed a name before its own state's
 *                                  roster ran. Caught by reading the placeholder list.
 *   Mountain View                  COLLISION ACROSS STATES — a global lookup found
 *                                  Washington's while importing Idaho's. Caught by a
 *                                  human asking whether a Bellevue school really plays
 *                                  thirteen games in Boise.
 *
 * All three were invisible to every automated check that existed when they happened.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This importer once ran roster-then-games PER STATE, which looks obviously fine and is
 * not. Idaho's GAMES ran before Nevada's ROSTER, so "Bishop Manogue" — a Reno school
 * Nevada rates — was first seen as an Idaho opponent and created as a STATELESS
 * PLACEHOLDER. Nevada's roster phase then found the name already indexed, judged it
 * present, and skipped it.
 *
 * The placeholder ABSORBED THE IDENTITY. Eight of Nevada's, Montana's and Arizona's own
 * rated teams ended up carrying state = NULL, invisible to /teams?state=NV while being
 * Nevada's teams.
 *
 * WHY IT IS DANGEROUS: identity absorption is SILENT BY CONSTRUCTION. There is no
 * duplicate row, no constraint violation, no error, and no count anomaly — the count
 * ladder still closed at UNEXPLAINED 0, because every ROW was accounted for. The ladder
 * proves rows are explained; it cannot prove a team got the right STATE. The defect
 * surfaced only because a human asked to see the placeholder list and read it.
 *
 * So the rule is structural rather than careful: every roster source is exhausted before
 * anything creates a team from an opponent string. Exhibit: Bishop Manogue, stateless,
 * while being Nevada's own rated team.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DEDUP. These states already appear in Oregon's and Washington's feeds as cross-border
 * opponents. Those rows must MATCH, not duplicate. The existing orientation-independent
 * key does that — window #3 proved it, importing 502 Washington games and adding zero
 * duplicate Oregon rows — so this reuses the same shape rather than inventing one.
 *
 * PROVENANCE. `source = 'laxnumbers'`, already priority 50 in `game_source_priority`,
 * below WHSBLA (90) and OHSLA (100). Where a league export and a ratings site disagree
 * about a score, the league wins, and a cross-border game keeps its league row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROSTER IS IMPORTED TOO, AND IT IS PROVISIONAL. Ruled 2026-08-03.
 *
 * For a rankings-only state, LaxNumbers IS the de facto authority — their rankings
 * already come from it, so taking their roster from the same place is CONSISTENCY, not
 * contamination. Our rosters for these states held 6/5/2/6 teams, created incidentally
 * as cross-border opponents of Oregon and Washington games; LaxNumbers rates 17/31/6/15.
 * Two thirds of the games were unimportable for want of teams, not aliases.
 *
 * These states stay NON-CURATED — no roster lock — precisely because this roster is
 * best-available rather than league-blessed.
 *
 * SUCCESSION PLAN, for 2027-us: when SWILA / HSLL partnerships land, the LEAGUE roster
 * supersedes this one and the curated-state sweep reconciles the two. That is the
 * Washington pattern and it is already proven — WHSBLA's export replaced an incidental
 * roster there without incident, because the importer matches on orientation-independent
 * identity rather than on which source created a row.
 *
 * So: this roster was ALWAYS PROVISIONAL. Do not treat a laxnumbers-sourced team as
 * settled identity, and do not be surprised when a league export renames half of them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const pool = require('../src/db');
const { scrapeLaxNumbers, scrapeLaxNumbersTeamGames } = require('../src/scrapers/laxnumbers');
const { getState } = require('../src/config/states');
const axios = require('axios');
const fs = require('fs');
const norm  = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const loose = s => norm(s).replace(/\b(high school|hs|school|academy|prep|the)\b/g, '').replace(/\s+/g, ' ').trim();
const path = require('path');

/**
 * Human rulings on placeholder origin. A name absent from the file stays NULL and renders
 * untagged — the honest outcome, not a gap for the importer to fill.
 */
const RULINGS = (() => {
  const f = path.join(__dirname, '..', 'data', 'placeholder-states.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const m = new Map();
  for (const p of d.placeholders) m.set(norm(p.name), p);
  return m;
})();

const COMMIT  = process.argv.includes('--commit');
const STAGE_C = process.argv.includes('--stage-c');
const SEASON  = 2026;
const STATES  = process.argv.filter(a => a.startsWith('--state='))
  .flatMap(a => a.slice(8).split(',')).map(x => x.trim().toUpperCase()).filter(Boolean);

/**
 * NEGATIVE DECISIONS — merges that must never be proposed again.
 *
 * A name-similarity sweep will suggest each of these every time it runs, and each one is
 * WRONG. Recorded here so the answer travels with the code rather than living in a memory
 * of a conversation.
 */
const DO_NOT_MERGE = [
  { keep: 'Brophy Prep II', never: 'brophy_az', why:
    'A JV / second squad. Merging its games into the varsity team would corrupt the ' +
    'varsity record — the same class of mistake as losing game_type, in team form. ' +
    'The name similarity guarantees every future sweep proposes exactly this merge.' },
];

async function ratingsRows(state) {
  const v = state.laxnumbersId;
  const { data } = await axios.get(`https://www.laxnumbers.com/ratings/service?y=${SEASON}&v=${v}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)',
      'Referer': `https://www.laxnumbers.com/ratings.php?y=${SEASON}&v=${v}`,
    }, timeout: 20000,
  });
  return data;
}

(async () => {
  if (pool.targetLabel === 'prod' && !STAGE_C) {
    console.error('FATAL: resolved target is "prod". Pass --stage-c to run deliberately.');
    process.exit(1);
  }
  if (!STATES.length) { console.error('FATAL: --state=XX required'); process.exit(1); }

  const c = await pool.getConnection();
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (writes nothing)'}`);
  console.log(`  states: ${STATES.join(', ')}\n`);

  const report = { perState: {}, unresolved: new Map() };
  try {
    await c.beginTransaction();

    // Every team we know about, by both strict and loose name, plus curated aliases.
    const [teams] = await c.execute('SELECT id, slug, name, state FROM teams');
    const [aliases] = await c.execute('SELECT team_id, alias FROM team_aliases');
    const idx = new Map(), looseIdx = new Map();
    for (const t of teams) {
      idx.set(norm(t.name), t.id); idx.set(norm(t.slug), t.id);
      looseIdx.set(loose(t.name), t.id); looseIdx.set(loose(t.slug), t.id);
    }
    for (const a of aliases) { idx.set(norm(a.alias), a.team_id); looseIdx.set(loose(a.alias), a.team_id); }
    const byId = new Map(teams.map(t => [t.id, t]));
    const teamState = new Map(teams.map(t => [t.id, t.state ?? null]));
    const stateIdx = new Map(), stateLooseIdx = new Map();
    for (const t of teams) {
      if (!t.state) continue;
      if (!stateIdx.has(t.state)) { stateIdx.set(t.state, new Map()); stateLooseIdx.set(t.state, new Map()); }
      stateIdx.get(t.state).set(norm(t.name), t.id);
      stateIdx.get(t.state).set(norm(t.slug), t.id);
      stateLooseIdx.get(t.state).set(loose(t.name), t.id);
      stateLooseIdx.get(t.state).set(loose(t.slug), t.id);
    }

    const slugify = (name, suffix) =>
      norm(name).replace(/\s+/g, '_').slice(0, 56) + (suffix || '');

    // Dry run SIMULATES creation — assigning a provisional id and indexing it — so the
    // count ladder below reflects what a commit would actually do. Without this every
    // opponent stays unresolved in dry run and the numbers describe nothing.
    let fakeId = -1;

    // EVERY GAME APPEARS ON BOTH TEAMS' PAGES. Without an in-run guard the importer sees
    // each one twice: in COMMIT the second lookup finds the row just written, but in DRY
    // RUN nothing is written, so the prediction came out ~2x the truth — which is exactly
    // the number a production window would have been planned against.
    const seenThisRun = new Set();

    /** Create a team we do not have. Provenance always; never silently. */
    async function createTeam(name, stateCode, suffix, why) {
      const slug = slugify(name, suffix);
      if (!COMMIT) {
        const id = fakeId--;
        idx.set(norm(name), id); looseIdx.set(loose(name), id);
        teamState.set(id, stateCode ?? null);
        if (stateCode) {
          if (!stateIdx.has(stateCode)) { stateIdx.set(stateCode, new Map()); stateLooseIdx.set(stateCode, new Map()); }
          stateIdx.get(stateCode).set(norm(name), id);
          stateLooseIdx.get(stateCode).set(loose(name), id);
        }
        return id;
      }
      const [r] = await c.execute(
        `INSERT INTO teams (slug, name, state) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
        [slug, name, stateCode]);
      const id = r.insertId;
      await c.execute(
        `INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
         VALUES (?,?,?, 'laxnumbers')`, [id, stateCode, name]);
      idx.set(norm(name), id); looseIdx.set(loose(name), id);
      teamState.set(id, stateCode ?? null);
      if (stateCode) {
        if (!stateIdx.has(stateCode)) { stateIdx.set(stateCode, new Map()); stateLooseIdx.set(stateCode, new Map()); }
        stateIdx.get(stateCode).set(norm(name), id);
        stateLooseIdx.get(stateCode).set(loose(name), id);
      }
      return id;
    }

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
      const rows = await ratingsRows(state);
      ratings.set(code, rows);
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
        await createTeam(t.name, code, state.slugSuffix, 'rated in-state team');
        created++;
      }
      console.log(`  ${code}: roster — created ${created} team(s) from the rated list`);
    }

    // ══ PHASE 2: games, with every roster already in place. ══
    for (const code of STATES) {
      const state = getState(code);
      const rows = ratings.get(code);
      const st = { teams: rows.length, gpTotal: 0, parsed: 0, resolved: 0, unresolved: 0,
                   matchedExisting: 0, wouldInsert: 0, ot: 0, ff: 0, noResult: 0,
                   placeholders: 0, gpFromSource: 0, mirrored: 0, ruled: 0, untagged: 0 };

      for (const t of rows) {
        st.gpTotal += t.gp || 0;
        // The rated team itself must exist in OUR roster; if it does not, that is an
        // unresolved ROSTER entry, reported the same way and never invented.
        const selfId = idx.get(norm(t.name)) ?? looseIdx.get(loose(t.name)) ?? null;
        const games = await scrapeLaxNumbersTeamGames(state, t.team_nbr);
        st.parsed += games.length;

        for (const g of games) {
          if (g.isOvertime) st.ot++;
          if (g.isForfeit) st.ff++;
          if (g.teamScore === null) { st.noResult++; continue; }   // nothing to import

          // SAME STATE FIRST. An opponent on state X's page is usually in X, and two
          // states can share a school name — resolving globally is how Idaho's Mountain
          // View became Washington's. A genuine cross-border opponent still resolves,
          // via the fallback.
          let oppId = stateIdx.get(code)?.get(norm(g.opponentRaw))
                   ?? stateLooseIdx.get(code)?.get(loose(g.opponentRaw))
                   ?? idx.get(norm(g.opponentRaw))
                   ?? looseIdx.get(loose(g.opponentRaw)) ?? null;

          // PLACEHOLDER WITH PROVENANCE. An opponent outside our coverage still played a
          // real game against a team we are importing, and dropping it would hide a real
          // result from the season we are importing to show. It becomes a team with NO
          // STATE — LaxNumbers publishes no state for an opponent string, and inventing
          // one would be the guess this rule exists to forbid. A stateless team renders
          // as a plain opponent name with no out-of-state tag, which is honest: we know
          // who they played, not where they are from.
          if (selfId && !oppId) {
            // A RULED origin, or NULL. Never a guess — see data/placeholder-states.json.
            const ruling = RULINGS.get(norm(g.opponentRaw)) || null;
            oppId = await createTeam(g.opponentRaw, ruling ? ruling.state : null, null,
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
          if (seenThisRun.has(runKey)) { st.mirrored++; continue; }
          seenThisRun.add(runKey);

          const [[existing]] = (homeId < 0 || awayId < 0) ? [[null]] : await c.execute(
            `SELECT id, canonical_source FROM games
              WHERE season = ? AND game_date = ?
                AND LEAST(home_team_id, away_team_id) = ?
                AND GREATEST(home_team_id, away_team_id) = ? LIMIT 1`,
            [SEASON, g.date, lo, hi]);
          if (existing) { st.matchedExisting++; continue; }        // cross-border row already ours
          st.wouldInsert++;

          if (COMMIT) {
            const [ins] = await c.execute(
              `INSERT INTO games (season, game_date, home_team_id, away_team_id,
                                  home_score, away_score, status, game_type,
                                  is_overtime, is_forfeit, canonical_source)
               VALUES (?,?,?,?,?,?, 'completed', 'non_league', ?, ?, 'laxnumbers')`,
              [SEASON, g.date, homeId, awayId,
               g.isHome ? g.teamScore : g.oppScore,
               g.isHome ? g.oppScore : g.teamScore,
               g.isOvertime ? 1 : 0, g.isForfeit ? 1 : 0]);
            await c.execute(
              `INSERT INTO game_source_records (game_id, source, scraped_at)
               VALUES (?, 'laxnumbers', NOW())
               ON DUPLICATE KEY UPDATE scraped_at = VALUES(scraped_at)`, [ins.insertId]);
          }
        }
        await new Promise(r => setTimeout(r, 120));   // politeness
      }
      report.perState[code] = st;
      console.log(`  ${code}: ${st.teams} rated teams, gp total ${st.gpTotal}, parsed ${st.parsed}`);
      console.log(`      resolved ${st.resolved}  unresolved ${st.unresolved}  ` +
                  `matched-existing ${st.matchedExisting}  would-insert ${st.wouldInsert}`);
      console.log(`      OT ${st.ot}  forfeits ${st.ff}  no-result ${st.noResult}`);
    }

    // ── THE COUNT LADDER, fourth edition ──────────────────────────────────────
    // Every parsed row is accounted for. A row that is neither imported nor explained
    // is the thing this exists to catch — three previous count ladders each found one.
    console.log('\n  ── COUNT LADDER — every parsed row accounted for ──');
    for (const [code, st] of Object.entries(report.perState)) {
      const explained = st.noResult + st.mirrored + st.matchedExisting + st.wouldInsert + st.unresolved;
      const gap = st.parsed - explained;
      console.log(`\n    ${code}`);
      console.log(`      source gp total (ratings service) ${String(st.gpTotal).padStart(5)}`);
      console.log(`      rows parsed from team pages       ${String(st.parsed).padStart(5)}`);
      console.log(`        - no result ("-")               ${String(st.noResult).padStart(5)}`);
      console.log(`        - the SAME game from the other   ${String(st.mirrored).padStart(5)}   (every game appears on both pages)`);
      console.log(`          team's page`);
      console.log(`        - matched an existing row       ${String(st.matchedExisting).padStart(5)}   (cross-border, NOT duplicated)`);
      console.log(`        - unresolved, skipped           ${String(st.unresolved).padStart(5)}`);
      console.log(`        = imported                      ${String(st.wouldInsert).padStart(5)}`);
      console.log(`      UNEXPLAINED                       ${String(gap).padStart(5)}   ${gap === 0 ? 'ok' : '*** INVESTIGATE ***'}`);
      // parsed-vs-gp: each game appears on BOTH teams' pages, so both double-count.
      console.log(`      distinct games seen               ${String(st.mirrored + st.matchedExisting + st.wouldInsert).padStart(5)}`);
      const delta = st.parsed - st.gpTotal;
      console.log(`      parsed − gp                       ${String(delta).padStart(5)}   ` +
                  `(no-result ${st.noResult}, forfeits ${st.ff})`);
      if (delta !== 0) {
        const hyp = st.noResult + st.ff;
        console.log(`        hypothesis: no-result + forfeits = ${hyp} ` +
                    `${hyp === delta ? '→ MATCHES the delta' : '→ does NOT match; still open'}`);
      }
    }

    // ── the long tail, for rulings ──
    const tail = [...report.unresolved.values()].sort((a, b) => b.count - a.count);
    console.log(`\n  UNRESOLVED OPPONENTS: ${tail.length} distinct name(s)\n`);
    for (const u of tail) {
      console.log(`    ${String(u.count).padStart(3)}×  [${u.state}] ${u.raw}`);
      u.samples.forEach(s => console.log(`           e.g. ${s}`));
      if (COMMIT) {
        await c.execute(
          `INSERT INTO unresolved_aliases (raw_name, source, state, context, occurrence_count)
           VALUES (?, 'laxnumbers', ?, ?, ?)
           ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + VALUES(occurrence_count),
                                   last_seen_at = NOW()`,
          [u.raw, u.state, u.samples[0] ?? null, u.count]);
      }
    }

    if (COMMIT) { await c.commit(); console.log('\n  COMMITTED\n'); }
    else        { await c.rollback(); console.log('\n  dry run — rolled back, nothing written\n'); }
  } catch (err) {
    await c.rollback();
    console.error(`\n  ROLLED BACK: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    c.release(); await pool.end();
  }
})();
