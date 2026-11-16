/**
 * The cron's LaxNumbers game job (diff 8). OFF unless an env var names the states.
 *
 *   LAXNUMBERS_GAMES_STATES   "ID,MT" …  which states. Validated by the registry
 *                             (parseLiveGamesStates): unset or blank = OFF; an unknown
 *                             code, a duplicate, or Oregon throws AT BOOT.
 *   LAXNUMBERS_GAMES_COMMIT   "1" writes. Unset, blank or "0" = a dry run: the import
 *                             runs inside a transaction that is rolled back, and nothing
 *                             is written anywhere, scrape_log included. Any other value
 *                             throws at boot: "true" silently meaning "dry run" is the
 *                             kind of quiet misreading WRITE_MODE taught us to refuse.
 *
 * Every run is CHANGED-ONLY (diff 7): a page is read when its games-played moved, when
 * nothing is stored for it, or once per Pacific day. 2 s between requests.
 *
 * READ CAP: 160 on a committing run (the core's default; a full pass is 150). 40 on a
 * dry run. A dry run stores nothing, so every dry run finds every page due again; without
 * its own cap, a dry run left switched on would send a full pass every two hours. With
 * it, a dry run reads the ratings and the first pages up to 40, which is enough to see
 * the job work, and a state larger than that is seen whole only by committing.
 *
 * Out of season, the job is simply left OFF: nothing is read and nothing is written.
 *
 * NEVER THROWS INTO THE CRON. A failure (the first 403 stops the whole job) is logged,
 * written to scrape_log on a committing run, and the cron goes on to `[done]`.
 */
const { parseLiveGamesStates, rosterLockedStates } = require('../config/states');
const { importLaxNumbersGames } = require('./index');

const SOURCE = 'laxnumbers-games';
const READ_CAP = { commit: 160, dryRun: 40 };

/** The job's settings from the environment. Throws on a value that is not understood. */
function gamesJobConfig(env = process.env) {
  const states = parseLiveGamesStates(env.LAXNUMBERS_GAMES_STATES);
  const raw = String(env.LAXNUMBERS_GAMES_COMMIT ?? '').trim();
  if (raw !== '' && raw !== '0' && raw !== '1') {
    throw new Error(`LAXNUMBERS_GAMES_COMMIT must be 1 (write), or 0 / unset (dry run); got "${raw}"`);
  }
  return { states, commit: raw === '1' };
}

const summary = st =>
  `read ${st.teams}, unchanged ${st.skipped}, over the cap ${st.capped}; ` +
  `insert ${st.inserted}, update ${st.updated}, fill ${st.filled}; unresolved ${st.unresolved}` +
  (st.identityConflicts ? `, identity conflicts ${st.identityConflicts}` : '');

/**
 * Runs the job once. `pool` is src/db; `logScrape(source, count, status, message, state)`
 * is index.js's. `importer` and `http` exist for tests and staging proofs; the cron
 * passes neither, so it gets the real import and live requests.
 */
async function runLaxNumbersGames({ pool, config, season, logScrape, importer = importLaxNumbersGames, http }) {
  const { states, commit } = config;
  if (!states.length) {
    console.log('[LaxNumbers games] off (LAXNUMBERS_GAMES_STATES unset)');
    return { ran: false };
  }
  console.log(`[LaxNumbers games] ${states.join(', ')} — ${commit ? 'COMMIT' : 'dry run'}, changed-only, ` +
              `at most ${commit ? READ_CAP.commit : READ_CAP.dryRun} reads, season ${season}`);

  let c = null;
  try {
    c = await pool.getConnection();
    // The core owns its transactions on commit; a dry run is wrapped in one that is
    // always rolled back, exactly as scripts/import-laxnumbers-games.js does.
    if (!commit) await c.beginTransaction();
    const { report } = await importer({
      c, commit, season, states, rosterLocked: new Set(rosterLockedStates()),
      changedOnly: true, maxRequests: commit ? READ_CAP.commit : READ_CAP.dryRun,
      ...(http ? { http } : {}) });
    if (!commit) await c.rollback();

    for (const code of states) {
      const st = report.perState[code];
      if (!st) continue;
      const status = st.unresolved || st.identityConflicts ? 'partial' : 'success';
      console.log(`[LaxNumbers games:${code}] ✓ ${commit ? '' : 'dry run — would: '}${summary(st)}`);
      if (commit) await logScrape(SOURCE, st.teams, status, summary(st), code);
    }
    return { ran: true, commit, report };
  } catch (err) {
    if (c && !commit) await c.rollback().catch(() => {});
    console.error('[LaxNumbers games] ✗', err.message);
    if (commit) for (const code of states) await Promise.resolve(logScrape(SOURCE, 0, 'error', err.message, code)).catch(() => {});
    return { ran: true, commit, error: err };
  } finally {
    if (c) c.release();
  }
}

module.exports = { gamesJobConfig, runLaxNumbersGames, SOURCE, READ_CAP };
