/**
 * The two LaxNumbers requests the game import makes: a state's ratings rows, and one
 * team's games page. Both go through the impit client in src/scrapers/laxnumbers.js —
 * Cloudflare 403s axios's TLS fingerprint (see 70b22b2).
 *
 * RECORD AND REPLAY. `http` = { mode: 'live' | 'record' | 'replay', dir, spacingMs }.
 *   live    request, nothing saved (the default; what the cron will do)
 *   record  request, and save each parsed response to `dir`
 *   replay  read `dir` only. A missing file is an ERROR, never a quiet live request, so
 *           a replayed run makes exactly zero LaxNumbers requests.
 * Responses are saved after parsing (ratings rows; a team page's game rows). The parser
 * is not what a replayed run tests, and saving parsed rows keeps the files readable.
 */
const fs = require('fs');
const path = require('path');
const { scrapeLaxNumbersTeamGames, fetchLaxNumbersRatingsRaw } = require('../scrapers/laxnumbers');

// 2 s between requests by default (diff 7): a full pass is ~150 requests, so ~5 minutes.
const LIVE = { mode: 'live', dir: null, spacingMs: 2000 };

function file(http, kind, key, season) {
  return path.join(http.dir, `${kind}-${key}-${season}.json`);
}
function readReplay(http, kind, key, season) {
  const f = file(http, kind, key, season);
  if (!fs.existsSync(f)) throw new Error(`replay: no recorded response ${path.basename(f)} in ${http.dir}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function save(http, kind, key, season, data) {
  fs.mkdirSync(http.dir, { recursive: true });
  fs.writeFileSync(file(http, kind, key, season), JSON.stringify(data, null, 1));
}

async function ratingsRows(state, season, http = LIVE, counter = { requests: 0 }) {
  if (http.mode === 'replay') return readReplay(http, 'ratings', state.code, season);
  counter.requests++;
  const rows = await fetchLaxNumbersRatingsRaw(state, season);
  if (http.mode === 'record') save(http, 'ratings', state.code, season, rows);
  return rows;
}

// Team pages are the bulk of a run (144 on a full pass), so their 200s are quiet and
// counted here; plan.js prints one summary line per state. Non-200s still log in full.
async function teamGames(state, teamNbr, season, pages, http = LIVE, counter = { requests: 0 }) {
  if (http.mode === 'replay') {
    const rec = readReplay(http, 'team', teamNbr, season);
    pages.replayed = (pages.replayed ?? 0) + 1;
    return rec.games;
  }
  counter.requests++;
  let ray = null;
  const games = await scrapeLaxNumbersTeamGames(state, teamNbr, season, {
    quiet: true,
    onOk: (r) => { ray = r; pages.ok++; pages.firstRay ??= r; pages.lastRay = r; },
  });
  if (http.mode === 'record') save(http, 'team', teamNbr, season, { state: state.code, teamNbr, cfRay: ray, games });
  return games;
}

// Spacing between requests. Nothing to wait for when replaying.
const politeness = (http = LIVE) => http.mode === 'replay' ? Promise.resolve()
  : new Promise(r => setTimeout(r, http.spacingMs));

module.exports = { ratingsRows, teamGames, politeness, LIVE };
