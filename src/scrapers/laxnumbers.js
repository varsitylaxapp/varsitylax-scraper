const axios = require('axios');

const API_URL = 'https://www.laxnumbers.com/ratings/service?y=2026&v=3443';
const SEASON  = parseInt(process.env.SEASON || '2026');

async function scrapeLaxNumbers() {
  console.log('[LaxNumbers] Fetching API:', API_URL);
  const { data: teams } = await axios.get(API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)',
      'Referer':    'https://www.laxnumbers.com/ratings.php?y=2026&v=3443',
    },
    timeout: 15000,
  });

  const results = teams.map(t => ({
    source:    'laxnumbers',
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

  console.log(`[LaxNumbers] Parsed ${results.length} teams`);
  return results;
}

module.exports = { scrapeLaxNumbers };
