// scrape_log rows exactly as the cron's LaxNumbers game job writes them, made BY THE JOB'S
// OWN CODE, so a test or a seed cannot drift from what production writes. Used by
// scripts/test-laxnumbers-games-health.js and the 9b staging proof.
//
//   successRows({ MT: { teams: 6, …, unresolved: 0 } })
//       runs runLaxNumbersGames (src/laxnumbers-games/cron.js) committing, with an importer
//       that returns that report, and collects what it hands logScrape: the job's own
//       summary line and its own success/partial rule.
//   errorRows(['MT'], 403)
//       runs runLaxNumbersGames with an importer that makes a real ratings request through
//       the job's fetch layer (src/laxnumbers-games/fetch.js → src/scrapers/laxnumbers.js),
//       with the impit client stubbed to answer `status`. The message is the scraper's own
//       throw, passed through the job's own error path into logScrape.
//
// No network: REQUIRING THIS FILE replaces the impit client for the whole process with a
// stub (tests and proofs only), and the outbound-IP lookup that a failed request triggers
// (api4.ipify.org) is answered locally. No database: the pool is a stand-in. Require it
// before anything loads src/scrapers/laxnumbers.js; it refuses otherwise.
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const stub = { status: 403 };
{
  const scraperPath = require.resolve(path.join(SRC, 'scrapers', 'laxnumbers'));
  if (require.cache[scraperPath]) {
    throw new Error('laxnumbers-games-rows: src/scrapers/laxnumbers.js is already loaded with the real client; require this file first');
  }
  const impitPath = require.resolve('impit');
  require.cache[impitPath] = { id: impitPath, filename: impitPath, loaded: true, exports: {
    Impit: class {
      async fetch() {
        return { status: stub.status, ok: stub.status >= 200 && stub.status < 300,
                 headers: { get: k => ({ 'cf-mitigated': 'challenge', 'cf-ray': 'test-SJC', server: 'cloudflare' })[k] ?? null },
                 text: async () => '<!DOCTYPE html><title>Just a moment...</title>' };
      }
    } } };
}
const quietly = async f => {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.error = err; }
};
const pool = { getConnection: async () => ({
  beginTransaction: async () => {}, rollback: async () => {}, commit: async () => {}, release: () => {} }) };

async function collect(states, importer) {
  const { runLaxNumbersGames } = require(path.join(SRC, 'laxnumbers-games', 'cron'));
  const rows = [];
  const logScrape = async (source, count, status, message, state) =>
    rows.push({ source, state, teams_scraped: count, status, error_message: message });
  const r = await quietly(() => runLaxNumbersGames({ pool, config: { states, commit: true }, season: 2026, logScrape, importer }));
  return { rows, result: r };
}

/** perState: { ST: { teams, skipped, capped, inserted, updated, filled, unresolved, identityConflicts } } */
async function successRows(perState) {
  const { rows } = await collect(Object.keys(perState), async () => ({ report: { perState } }));
  return rows;
}

async function errorRows(states, status = 403) {
  stub.status = status;
  const https = require('https');
  const realGet = https.get;
  https.get = (opts, cb) => {             // the outbound-IP lookup, answered locally
    const { EventEmitter } = require('events');
    const req = new EventEmitter(); req.destroy = () => {};
    process.nextTick(() => req.emit('error', new Error('no network in this test')));
    return req;
  };
  try {
    const { ratingsRows } = require(path.join(SRC, 'laxnumbers-games', 'fetch'));
    const { getState } = require(path.join(SRC, 'config', 'states'));
    const { rows } = await collect(states, async ({ states: s, season }) => {
      await ratingsRows(getState(s[0]), season);
      throw new Error('errorRows: the stubbed request did not throw');
    });
    return rows;
  } finally { https.get = realGet; }
}

module.exports = { successRows, errorRows };
