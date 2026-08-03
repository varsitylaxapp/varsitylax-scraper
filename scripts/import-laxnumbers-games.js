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
 * DEDUP. These states already appear in Oregon's and Washington's feeds as cross-border
 * opponents. Those rows must MATCH, not duplicate. The existing orientation-independent
 * key does that — window #3 proved it, importing 502 Washington games and adding zero
 * duplicate Oregon rows — so this reuses the same shape rather than inventing one.
 *
 * PROVENANCE. `source = 'laxnumbers'`, already priority 50 in `game_source_priority`,
 * below WHSBLA (90) and OHSLA (100). Where a league export and a ratings site disagree
 * about a score, the league wins, and a cross-border game keeps its league row.
 */
const pool = require('../src/db');
const { scrapeLaxNumbers, scrapeLaxNumbersTeamGames } = require('../src/scrapers/laxnumbers');
const { getState } = require('../src/config/states');
const axios = require('axios');

const COMMIT  = process.argv.includes('--commit');
const STAGE_C = process.argv.includes('--stage-c');
const SEASON  = 2026;
const STATES  = process.argv.filter(a => a.startsWith('--state='))
  .flatMap(a => a.slice(8).split(',')).map(x => x.trim().toUpperCase()).filter(Boolean);

const norm  = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const loose = s => norm(s).replace(/\b(high school|hs|school|academy|prep|the)\b/g, '').replace(/\s+/g, ' ').trim();

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

    for (const code of STATES) {
      const state = getState(code);
      if (!state) throw new Error(`unknown state ${code}`);
      const rows = await ratingsRows(state);
      const st = { teams: rows.length, gpTotal: 0, parsed: 0, resolved: 0, unresolved: 0,
                   matchedExisting: 0, wouldInsert: 0, ot: 0, ff: 0, noResult: 0 };

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

          const oppId = idx.get(norm(g.opponentRaw)) ?? looseIdx.get(loose(g.opponentRaw)) ?? null;
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
          const [[existing]] = await c.execute(
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
