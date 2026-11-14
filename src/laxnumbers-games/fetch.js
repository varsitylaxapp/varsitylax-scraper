/**
 * The two LaxNumbers requests the game import makes: a state's ratings rows, and one
 * team's games page. Both go through the impit client in src/scrapers/laxnumbers.js —
 * Cloudflare 403s axios's TLS fingerprint (see 70b22b2).
 */
const { scrapeLaxNumbersTeamGames, fetchLaxNumbersRatingsRaw } = require('../scrapers/laxnumbers');

async function ratingsRows(state, season) {
  return fetchLaxNumbersRatingsRaw(state, season);
}

async function teamGames(state, teamNbr, season) {
  return scrapeLaxNumbersTeamGames(state, teamNbr, season);
}

const politeness = () => new Promise(r => setTimeout(r, 120));

module.exports = { ratingsRows, teamGames, politeness };
