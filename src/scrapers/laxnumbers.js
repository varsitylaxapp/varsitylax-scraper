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

module.exports = { scrapeLaxNumbers };
