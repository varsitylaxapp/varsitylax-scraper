const axios   = require('axios');
const cheerio = require('cheerio');

const URL    = 'https://laxmath.com/laxpower/boys/oregonb.php';
const SEASON = parseInt(process.env.SEASON || '2026');

async function scrapeLaxPower() {
  console.log('[LaxPower] Fetching', URL);
  const { data: html } = await axios.get(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)' },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  // DataTables renders all rows in the DOM even when paginated —
  // grab every tbody tr directly rather than relying on visible page.
  const table = $('#rankingTable');
  if (!table.length) {
    throw new Error('Could not find #rankingTable on LaxPower page');
  }

  const rows    = table.find('tbody tr').toArray();
  const results = [];

  for (const row of rows) {
    const cells = $(row).find('td');
    if (cells.length < 2) continue;

    // Column 0: Record (e.g. "5-0")
    const recordText = $(cells[0]).text().trim();

    // Column 1: "8 . Mountain Vie" — rank + name combined
    const rankNameText = $(cells[1]).text().trim();

    // Last column: Consensus value
    const consensusText = $(cells[cells.length - 1]).text().trim();

    // Parse rank and name from "8 . Mountain Vie"
    const dotIndex = rankNameText.indexOf('.');
    if (dotIndex === -1) continue;

    const rank     = parseInt(rankNameText.slice(0, dotIndex).trim());
    const teamName = rankNameText.slice(dotIndex + 1).trim();
    const consensus = parseFloat(consensusText);

    if (isNaN(rank) || !teamName || isNaN(consensus)) continue;

    const [wins, losses] = parseRecord(recordText);

    results.push({
      source:    'laxpower',
      rank,
      teamName:  teamName.replace(/\s+/g, ' ').trim(),
      record:    recordText,
      wins,
      losses,
      consensus,
      season:    SEASON,
      scrapedAt: new Date(),
    });
  }

  console.log(`[LaxPower] Parsed ${results.length} teams`);
  return results;
}

function parseRecord(record) {
  const parts = record.split('-').map(Number);
  const wins   = parts[0] || 0;
  const losses = parts[1] || 0;
  return [wins, losses];
}

module.exports = { scrapeLaxPower };
