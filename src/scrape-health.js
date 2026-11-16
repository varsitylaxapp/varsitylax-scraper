// LaxNumbers scrape health: how many runs in a row each state's LaxNumbers request has
// failed. Read by GET /api/v2/health/laxnumbers, which the uptime monitor polls.
//
// WHY. On 2026-11-12 every cron run got 403 from LaxNumbers on all six states for most of
// a day, and nothing paged: /health only reports the last successful write, and
// LaxPower/OHSLA kept succeeding, so the API looked healthy. A block is invisible unless
// something counts consecutive failures.
//
// A RUN, per state, is one scrape_log row for the rankings request:
//   'laxnumbers'    status 'error'                       a failed run (both write modes)
//   'laxnumbers-v2' status 'success' | 'partial'         a good run (WRITE_MODE=v2, the cron)
//   'laxnumbers'    status 'success'                     a good run (legacy write, Oregon)
//   any status other than 'error' ('skipped', preseason) is NOT a failure.
// Consecutive failures = leading 'error' rows, newest first, until the first non-error.
// 'partial' (unresolved names) is a good run: the request worked; that is a data matter.
//
// PUBLIC BODY: no error text. The endpoint is unauthenticated, and error_message carries
// request URLs and whatever a dependency put in its message. Only the time of the last
// error and its HTTP status code are returned.

const THRESHOLD = 3;
const SOURCES = ['laxnumbers', 'laxnumbers-v2'];

/**
 * The HTTP status code in a LaxNumbers error_message, or null. scrape_log has no status
 * column, so this reads the two fixed messages the code throws and nothing else:
 *   "LaxNumbers 403 for <url>"               src/scrapers/laxnumbers.js (impit, now)
 *   "Request failed with status code 504"     axios (the client before 70b22b2)
 * A timeout or connection error has no status: null. So does any other text.
 */
function httpStatusOf(message) {
  const m = /^LaxNumbers (\d{3}) for /.exec(message ?? '')
         ?? /^Request failed with status code (\d{3})$/.exec(message ?? '');
  return m ? Number(m[1]) : null;
}

/** Rows newest first → the number of leading failures. Pure, so it can be tested alone. */
function consecutiveFailures(rows) {
  let n = 0;
  for (const r of rows) { if (r.status !== 'error') break; n++; }
  return n;
}

/**
 * One entry per state code. `db` is src/db (or anything with execute()). `window` caps
 * how many rows are read: a count at the window size means "at least that many", which
 * is all an alert needs.
 */
async function laxnumbersHealth(db, states, { window = 25 } = {}) {
  const ph = SOURCES.map(() => '?').join(',');
  const out = [];
  for (const state of states) {
    const [rows] = await db.execute(
      `SELECT status, error_message, scraped_at FROM scrape_log
        WHERE state = ? AND source IN (${ph}) ORDER BY id DESC LIMIT ${Number(window)}`,
      [state, ...SOURCES]);
    const [[ok]] = await db.execute(
      `SELECT MAX(scraped_at) AS at FROM scrape_log
        WHERE state = ? AND source IN (${ph}) AND status <> 'error'`, [state, ...SOURCES]);
    const lastErr = rows.find(r => r.status === 'error') || null;
    out.push({
      state,
      consecutiveFailedRuns: consecutiveFailures(rows),
      lastSuccessAt: ok.at || null,
      lastErrorAt: lastErr ? lastErr.scraped_at : null,
      lastErrorHttpStatus: lastErr ? httpStatusOf(lastErr.error_message) : null,
    });
  }
  return out;
}

module.exports = { THRESHOLD, SOURCES, consecutiveFailures, httpStatusOf, laxnumbersHealth };

// ── The cron's LaxNumbers GAME job (diff 9b) ─────────────────────────────────────────────
// Read by GET /api/v2/health/laxnumbers-games. The functions above are untouched.
//
// A RUN, per state, is one scrape_log row with source 'laxnumbers-games'. Only a COMMITTING
// run writes one (src/laxnumbers-games/cron.js): a dry run writes none, and the job when
// OFF writes none.
//   status 'error'                 a failed run; the message is the thrown error, and a
//                                  blocked request reads "LaxNumbers 403 for <url>"
//   status 'success' | 'partial'   a good run; the message is the job's summary line
//
// WHICH STATES. The API cannot see the cron's variables, so "switched off" and "stopped"
// look the same from here. A game-job state is listed while it has a row in the last
// GAMES_RECENT_DAYS days, and only those rows are read. So a state that is switched off
// after 3 failed runs keeps the endpoint at 503 until those rows are older than 7 days,
// or until a good run is logged for it. Staleness is therefore a flag (missedDailyPass),
// never a 503.
//
// FLAGS warn and never cause a 503:
//   overCapLastRun     the newest run had pages over the read cap
//   unresolvedLastRun  the newest run's count of unresolved names
//   missedDailyPass    the newest row is more than GAMES_STALE_HOURS old
// The first two are read from the newest row's summary with ONE strict pattern. When that
// row is an error, or its text does not match, they are null: never a guess, never text.
// Row ages are computed by the database against its own NOW(), the same clock that fills
// scraped_at's default.
const GAMES_SOURCE = 'laxnumbers-games';
const GAMES_RECENT_DAYS = 7;
const GAMES_STALE_HOURS = 26;
// The summary line src/laxnumbers-games/cron.js writes. Tested against lines built by
// that code (scripts/test-laxnumbers-games-health.js), so the two cannot drift silently.
const GAMES_SUMMARY = /^read (\d+), unchanged (\d+), over the cap (\d+); insert (\d+), update (\d+), fill (\d+); unresolved (\d+)(?:, identity conflicts (\d+))?$/;

/** The game job's summary line → its counts, or null when the text does not match. Pure. */
function parseGamesSummary(message) {
  const m = GAMES_SUMMARY.exec(message ?? '');
  if (!m) return null;
  const n = i => (m[i] == null ? 0 : Number(m[i]));
  return { teams: n(1), skipped: n(2), capped: n(3), inserted: n(4), updated: n(5), filled: n(6),
           unresolved: n(7), identityConflicts: n(8) };
}

/**
 * One entry per state that has a game-job row in the last GAMES_RECENT_DAYS days; a state
 * with none is left out. `states` is the game-job states in registry order.
 */
async function gamesHealth(db, states, { window = 25 } = {}) {
  const out = [];
  for (const state of states) {
    const [rows] = await db.execute(
      `SELECT status, error_message, scraped_at,
              (scraped_at < NOW() - INTERVAL ${GAMES_STALE_HOURS} HOUR) AS stale
         FROM scrape_log
        WHERE state = ? AND source = ? AND scraped_at >= NOW() - INTERVAL ${GAMES_RECENT_DAYS} DAY
        ORDER BY id DESC LIMIT ${Number(window)}`,
      [state, GAMES_SOURCE]);
    if (!rows.length) continue;
    const [[ok]] = await db.execute(
      `SELECT MAX(scraped_at) AS at FROM scrape_log
        WHERE state = ? AND source = ? AND status <> 'error'`, [state, GAMES_SOURCE]);
    const newest = rows[0];
    const lastErr = rows.find(r => r.status === 'error') || null;
    const summary = newest.status === 'error' ? null : parseGamesSummary(newest.error_message);
    out.push({
      state,
      consecutiveFailedRuns: consecutiveFailures(rows),
      lastSuccessAt: ok.at || null,
      lastErrorAt: lastErr ? lastErr.scraped_at : null,
      lastErrorHttpStatus: lastErr ? httpStatusOf(lastErr.error_message) : null,
      overCapLastRun: summary ? summary.capped > 0 : null,
      unresolvedLastRun: summary ? summary.unresolved : null,
      missedDailyPass: Boolean(Number(newest.stale)),
    });
  }
  return out;
}

module.exports.GAMES_SOURCE = GAMES_SOURCE;
module.exports.GAMES_RECENT_DAYS = GAMES_RECENT_DAYS;
module.exports.GAMES_STALE_HOURS = GAMES_STALE_HOURS;
module.exports.parseGamesSummary = parseGamesSummary;
module.exports.gamesHealth = gamesHealth;
