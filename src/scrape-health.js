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
