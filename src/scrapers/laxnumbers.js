const axios = require('axios');
const { getState, DEFAULT_STATE } = require('../config/states');

const SEASON = parseInt(process.env.SEASON || '2026');

// NOTE: this is a plain JSON fetch, not a rendered page. There is no
// JS-rendering path in this codebase — /ratings/service returns JSON directly.
//
// `state` is a record from config/states.js. Defaults to Oregon so any existing
// zero-arg caller is unchanged.
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
  const { data: teams } = await axios.get(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)',
      'Referer':    referer,
    },
    timeout: 15000,
  });

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
 * A team's 2026 games, from /team_info.php?t=<team_nbr>.
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
 *   "N - N OT"      13   OVERTIME, so is_overtime comes free
 *   "-"              5   no result: scheduled, cancelled or never played
 *   "N - N (F)"      1   FORFEIT, so is_forfeit comes free too
 *
 * Nothing here writes. Parsing and fetching only.
 */
async function scrapeLaxNumbersTeamGames(state, teamNbr) {
  const referer = `https://www.laxnumbers.com/ratings.php?y=${SEASON}&v=${state.laxnumbersId}`;
  const url = `https://www.laxnumbers.com/team_info.php?y=${SEASON}&t=${teamNbr}`;

  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)',
      'Referer':    referer,
    },
    timeout: 20000,
  });

  const cellText = c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
                         .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  const games = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1]));
    if (cells.length < 5) continue;
    const date = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;     // header and layout rows

    const rawOpponent = cells[2];
    if (!rawOpponent) continue;
    // `at ` is away. Bare and `vs ` are treated as home — see the neutral-site note.
    const isAway   = /^at\s+/i.test(rawOpponent);
    const opponent = rawOpponent.replace(/^(?:at|vs|@)\s+/i, '').trim();
    if (!opponent) continue;

    // "18 - 5", optionally " OT" or " (F)". This team's score first.
    const m = cells[4].match(/^(\d+)\s*-\s*(\d+)\s*(OT|\(F\))?$/i);
    const suffix = (m && m[3] ? m[3] : '').toUpperCase();
    games.push({
      source:      'laxnumbers',
      state:       state.code,
      season:      SEASON,
      date,
      time:        cells[1] || null,
      opponentRaw: opponent,
      isHome:      !isAway,
      isNeutralHint: /^vs\s+/i.test(rawOpponent),
      teamScore:   m ? parseInt(m[1]) : null,
      oppScore:    m ? parseInt(m[2]) : null,
      isOvertime:  suffix === 'OT',
      isForfeit:   suffix === '(F)',
      scrapedAt:   new Date(),
    });
  }
  return games;
}

module.exports = { scrapeLaxNumbers, scrapeLaxNumbersTeamGames };
