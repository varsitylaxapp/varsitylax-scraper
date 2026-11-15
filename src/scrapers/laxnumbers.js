const { Impit } = require('impit');
const { getState, DEFAULT_STATE } = require('../config/states');

const SEASON = parseInt(process.env.SEASON || '2026');

// 2026-10: LaxNumbers now sits behind Cloudflare bot management. The block is on
// the TLS/HTTP client fingerprint, not the IP — axios/curl get 403 "Just a
// moment…" from Railway AND from a residential line, while a Chrome fingerprint
// gets 200 from a datacenter. impit impersonates Chrome's handshake with no
// browser. Same fetch() API; responses are unchanged.
const client = new Impit({ browser: 'chrome', timeout: 20000 });

// 2026-11-12: after the f79c1a5 deploy every cron run got 403 on all six states, while
// the api container (same image) got 200. These logs exist to tell an IP block from a
// fingerprint block on the next failure. Logging only: no retries, no change to the
// request, and the thrown message stays byte-identical because it lands in scrape_log.
const https = require('https');
let outboundIpv4; // one lookup per process; the cron is a fresh process every run
let ipLogged = false; // and one log line
function lookupOutboundIpv4() {
  if (!outboundIpv4) {
    outboundIpv4 = new Promise((resolve) => {
      const req = https.get({ host: 'api4.ipify.org', path: '/', family: 4, timeout: 5000 }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve(res.statusCode === 200 ? b.trim() : `unknown (ipify ${res.statusCode})`));
        res.on('error', (e) => resolve(`unknown (${e.message})`));
      });
      req.on('timeout', () => req.destroy(new Error('timeout after 5s')));
      req.on('error', (e) => resolve(`unknown (${e.message})`));
    });
  }
  return outboundIpv4;
}

// 2026-11-14: a cron deployment that left from an Amazon address was challenged on every
// run; the same image on Railway's own network got 200. The IP used to be logged only on a
// failure, so a passing run said nothing about where it ran. Now the cron logs it once per
// run, pass or fail. Never throws: the lookup resolves to "unknown (…)" on any error or
// after 5 s. `log` lets the failure path keep writing to stderr as before.
async function logOutboundIpv4(log = console.log) {
  if (ipLogged) return;
  ipLogged = true;
  try { log(`[LaxNumbers] outbound IPv4=${await lookupOutboundIpv4()}`); }
  catch (e) { log(`[LaxNumbers] outbound IPv4=unknown (${e.message})`); }
}

// `quiet` is for bulk callers (one request per team page): a 200 is not logged here and
// `onOk(cfRay)` hands the ray to the caller, which prints one summary line instead.
// A non-200 is ALWAYS logged in full, quiet or not — that is the evidence the 403 work
// exists to keep.
async function fetchLaxNumbers(url, referer, { quiet = false, onOk } = {}) {
  const res = await client.fetch(url, { headers: { Referer: referer } });
  const h = (k) => res.headers.get(k) ?? '-';
  if (res.status === 200) {
    if (!quiet) console.log(`[LaxNumbers] 200 cf-ray=${h('cf-ray')}`);
    if (onOk) onOk(h('cf-ray'));
  } else {
    // Read the body only when we are about to throw; a 2xx caller still needs it.
    let body = '(not read: 2xx)';
    if (!res.ok) {
      try { body = (await res.text()).slice(0, 300); } catch (e) { body = `(unreadable: ${e.message})`; }
    }
    console.error(`[LaxNumbers] ${res.status} ${url} cf-mitigated=${h('cf-mitigated')} ` +
      `cf-ray=${h('cf-ray')} server=${h('server')} body=${JSON.stringify(body)}`);
    await logOutboundIpv4(console.error);
  }
  if (!res.ok) throw new Error(`LaxNumbers ${res.status} for ${url}`);
  return res;
}

// NOTE: this is a plain JSON fetch, not a rendered page. There is no
// JS-rendering path in this codebase — /ratings/service returns JSON directly.
//
// `state` is a record from config/states.js. Defaults to Oregon so any existing
// zero-arg caller is unchanged.
/**
 * A season the caller must state. The game import's fetchers take no default: a missing
 * season silently meaning 2026 is how a 2027 run would scrape the wrong year and report
 * success. Thrown before any request is made.
 */
function requireSeason(season, fn) {
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    throw new Error(`[LaxNumbers] ${fn}: season must be a year in 2000–2100, got ${JSON.stringify(season)}`);
  }
  return season;
}

async function scrapeLaxNumbers(state = getState(DEFAULT_STATE)) {
  if (!state.laxnumbersId) {
    throw new Error(`[LaxNumbers] ${state.code} has no laxnumbersId configured`);
  }

  // y= was previously hardcoded to 2026 while SEASON was read from env but never
  // used — setting SEASON=2027 silently scraped 2026. Fixed; a no-op at the
  // current config (SEASON=2026) so the request is byte-identical today.
  const qs      = `y=${SEASON}&v=${state.laxnumbersId}`;
  const apiUrl  = `https://www.laxnumbers.com/ratings/service?${qs}`;
  const referer = `https://www.laxnumbers.com/ratings.php?${qs}`;

  console.log(`[LaxNumbers:${state.code}] Fetching API:`, apiUrl);
  const teams = await (await fetchLaxNumbers(apiUrl, referer)).json();

  const results = teams.map(t => ({
    source:    'laxnumbers',
    state:     state.code,
    rank:      t.ranking,
    teamName:  t.name.replace(/\s+/g, ' ').trim(),
    record:    `${t.wins}-${t.losses}`,
    wins:      t.wins,
    losses:    t.losses,
    rating:    t.rating,
    agd:       t.agd,
    sched:     t.sched,
    season:    SEASON,
    scrapedAt: new Date(),
  }));

  console.log(`[LaxNumbers:${state.code}] Parsed ${results.length} teams`);
  return results;
}

/**
 * The ratings service's rows for one state and season, UNTOUCHED.
 *
 * scrapeLaxNumbers() maps rows into ranking entries and drops `team_nbr`, `gp` and
 * `state`, which the game importer needs: `team_nbr` addresses the team page, `gp` closes
 * the count ladder, and `state` says which state a rated row belongs to (a feed can carry
 * a neighbour's teams — Idaho's lists WA, MT and WY schools).
 *
 * Same URL shape and Referer as scrapeLaxNumbers(), through the same impit client.
 */
async function fetchLaxNumbersRatingsRaw(state, season) {
  requireSeason(season, 'fetchLaxNumbersRatingsRaw');
  if (!state.laxnumbersId) {
    throw new Error(`[LaxNumbers] ${state.code} has no laxnumbersId configured`);
  }
  const qs   = `y=${season}&v=${state.laxnumbersId}`;
  const rows = await (await fetchLaxNumbers(
    `https://www.laxnumbers.com/ratings/service?${qs}`,
    `https://www.laxnumbers.com/ratings.php?${qs}`)).json();
  if (!Array.isArray(rows)) {
    throw new Error(`[LaxNumbers] ${state.code} ${season}: ratings service did not return an array`);
  }
  return rows;
}

/**
 * A team's games for one season, from /team_info.php?t=<team_nbr>.
 *
 * `season` is REQUIRED (no $SEASON default): the game import passes its own season.
 * `opts` ({ quiet, onOk }) is passed through to the request; see fetchLaxNumbers.
 *
 * HTML, not JSON — there is no service endpoint for games, and no embedded payload. The
 * schedule is a table, parsed the same way the OHSLA scraper parses its pages.
 *
 * ROW SHAPE, from the 2026-08-03 probe (one team sampled per state, every row matching
 * the ratings service's own `gp`):
 *
 *   ["2026-01-31", "12:30", "Palo Verde",        "n/a", "18 - 5", ""]
 *   ["2026-02-25", "19:30", "at Corona del Sol", "",    "19 - 2", ""]
 *
 *   col 0  date       ALREADY ISO. No parsing, no ambiguity, no timezone.
 *   col 1  time       24h, occasionally blank
 *   col 2  opponent   an "at " prefix is the ONLY home/away signal
 *   col 4  score      "18 - 5", THIS TEAM FIRST
 *
 * WHAT THIS SOURCE CANNOT ASSERT, and therefore what the importer must not invent:
 *
 *   game_type   LaxNumbers does not distinguish exhibitions, scrimmages or playoffs. It
 *               publishes what counts toward a rating and nothing about a game's status
 *               in a league. Every row imports as `non_league`; anything finer would be
 *               a guess wearing a column.
 *   venue       absent entirely.
 *   conference  absent entirely.
 *   neutral     a `vs ` prefix (12 of 379 sampled rows) is neither `at ` nor bare, and
 *               most likely marks a neutral site — but the page never says so. Treated
 *               as HOME, because it is explicitly not `at`, and recorded here as an
 *               assumption rather than a fact.
 *
 * WHAT IT CAN ASSERT, discovered by surveying 379 rows across 24 teams rather than
 * assuming — an earlier scoping note claimed forfeits were indistinguishable and was
 * wrong:
 *
 *   "N - N"        360   an ordinary result
 *   "N - N OT"      13   OVERTIME, so is_overtime comes free ("N - N 2OT" too, seen
 *                        once in 2026; any "<n>OT" counts)
 *   "-"              5   no result: scheduled, cancelled or never played
 *   "N - N (F)"      1   FORFEIT, so is_forfeit comes free too
 *
 * Nothing here writes. Parsing and fetching only.
 */
async function scrapeLaxNumbersTeamGames(state, teamNbr, season, opts = {}) {
  requireSeason(season, 'scrapeLaxNumbersTeamGames');
  const referer = `https://www.laxnumbers.com/ratings.php?y=${season}&v=${state.laxnumbersId}`;
  const url = `https://www.laxnumbers.com/team_info.php?y=${season}&t=${teamNbr}`;

  const html = await (await fetchLaxNumbers(url, referer, opts)).text();
  return parseLaxNumbersTeamGames(html, state, season);
}

/**
 * The table parse behind scrapeLaxNumbersTeamGames, split out so fixtures can test it
 * without a request.
 *
 * `opponentNbr` is the LaxNumbers team number from the opponent cell's link
 * (team_info.php?…&t=<n>), or null when the cell has no link. It is the page's own
 * identity for the opponent, so the import resolves by it before it ever reads the name
 * (2026-11-13: across 1,862 linked rows in five states it never disagreed with a correct
 * name match, and the one disagreement was our name lookup's error, not the page's).
 *
 * Overtime may carry a count: "9 - 8 2OT" (Borah/Capital v Boise, 2026-04-21, the only
 * such cell in 1,932 rows). Any "<n>OT" is overtime.
 */
function parseLaxNumbersTeamGames(html, state, season) {
  const cellText = c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
                         .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  const games = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const raw = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1]);
    const cells = raw.map(cellText);
    if (cells.length < 5) continue;
    const date = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;     // header and layout rows

    const rawOpponent = cells[2];
    if (!rawOpponent) continue;
    // `at ` is away. Bare and `vs ` are treated as home — see the neutral-site note.
    const isAway   = /^at\s+/i.test(rawOpponent);
    const opponent = rawOpponent.replace(/^(?:at|vs|@)\s+/i, '').trim();
    if (!opponent) continue;
    const link = raw[2].match(/team_info\.php\?[^"'>]*?\bt=(\d+)/i);

    // "18 - 5", optionally " OT", " 2OT" or " (F)". This team's score first.
    const m = cells[4].match(/^(\d+)\s*-\s*(\d+)\s*(\d*OT|\(F\))?$/i);
    const suffix = (m && m[3] ? m[3] : '').toUpperCase();
    games.push({
      source:      'laxnumbers',
      state:       state.code,
      season,
      date,
      time:        cells[1] || null,
      opponentRaw: opponent,
      opponentNbr: link ? Number(link[1]) : null,
      isHome:      !isAway,
      isNeutralHint: /^vs\s+/i.test(rawOpponent),
      teamScore:   m ? parseInt(m[1]) : null,
      oppScore:    m ? parseInt(m[2]) : null,
      isOvertime:  /OT$/.test(suffix),
      isForfeit:   suffix === '(F)',
      scrapedAt:   new Date(),
    });
  }
  return games;
}

module.exports = { scrapeLaxNumbers, scrapeLaxNumbersTeamGames, parseLaxNumbersTeamGames,
                   fetchLaxNumbersRatingsRaw, logOutboundIpv4 };
