#!/usr/bin/env node
/**
 * Import one season of game results for the NON-CURATED states (AZ, ID, MT, NV) from
 * LaxNumbers. Washington may be DRY RUN only — see ROSTER_LOCKED below.
 *
 *   ./scripts/staging scripts/import-laxnumbers-games.js --state=ID
 *   ./scripts/staging scripts/import-laxnumbers-games.js --state=ID --season=2027
 *   ./scripts/staging scripts/import-laxnumbers-games.js --state=ID --commit
 *   node scripts/import-laxnumbers-games.js --state=ID --stage-c --commit     (prod)
 *
 * SEASON: --season=YYYY, else $SEASON, else 2026. The resolved value and where it came
 * from are printed in the banner. Anything outside 2000–2100 is refused.
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
const { importLaxNumbersGames, recordUnresolved } = require('../src/laxnumbers-games');

const COMMIT  = process.argv.includes('--commit');
const STAGE_C = process.argv.includes('--stage-c');
const STATES  = process.argv.filter(a => a.startsWith('--state='))
  .flatMap(a => a.slice(8).split(',')).map(x => x.trim().toUpperCase()).filter(Boolean);

/**
 * --season=YYYY, else $SEASON, else 2026. A malformed value is FATAL rather than a
 * fallback: `--season 2027` (space, no `=`) silently importing 2026 is the exact failure
 * scrapeLaxNumbers() once had with y= hardcoded.
 */
const { SEASON, SEASON_FROM } = (() => {
  const fatal = msg => { console.error(`FATAL: ${msg}`); process.exit(1); };
  if (process.argv.includes('--season')) fatal('--season needs a value: --season=YYYY');
  const flags = process.argv.filter(a => a.startsWith('--season='));
  if (flags.length > 1) fatal('--season given more than once');
  const env = (process.env.SEASON ?? '').trim();
  const [raw, from] = flags.length ? [flags[0].slice(9).trim(), '--season']
                    : env           ? [env, '$SEASON']
                    :                 ['2026', 'default'];
  const n = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 2000 && n <= 2100)) fatal(`season "${raw}" (from ${from}) is not a year in 2000–2100`);
  return { SEASON: n, SEASON_FROM: from };
})();

/**
 * ROSTER-LOCKED STATES: a league export owns the roster, so this importer may MATCH a
 * team but never CREATE one. A rated team or opponent that does not resolve inside the
 * lock goes to the unresolved list — never a placeholder, never a guess.
 *
 * Washington's roster is WHSBLA's. Dry run only for now: --commit is refused below until
 * a WA write path has been reviewed on its own.
 */
const ROSTER_LOCKED = new Set(['WA']);
const LOCKED_HERE   = STATES.filter(s => ROSTER_LOCKED.has(s));
if (COMMIT && LOCKED_HERE.length) {
  console.error(`FATAL: --commit refused for roster-locked ${LOCKED_HERE.join(', ')} — dry run only.`);
  process.exit(1);
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
  console.log(`  season: ${SEASON} (${SEASON_FROM})`);
  console.log(`  states: ${STATES.join(', ')}\n`);

  try {
    await c.beginTransaction();

    const { ctx, report } = await importLaxNumbersGames({
      c, commit: COMMIT, season: SEASON, states: STATES, rosterLocked: ROSTER_LOCKED });

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
      // A GAME, not a row: every game appears on both teams' pages, and `mirrored` counts
      // the second sighting. Each resolved game's FIRST sighting is either matched or
      // imported, so those two alone count games. (This line used to add `mirrored`,
      // which made it the resolved-ROW count.) Unresolved rows cannot be paired into
      // games — their opponent has no id — so they stay a row count, on their own line.
      console.log(`      distinct games (resolved)         ${String(st.matchedExisting + st.wouldInsert).padStart(5)}`);
      console.log(`      unresolved rows (not paired)      ${String(st.unresolved).padStart(5)}`);
      // parsed-vs-gp: each game appears on BOTH teams' pages, so both double-count.
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
    await recordUnresolved(ctx);

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
