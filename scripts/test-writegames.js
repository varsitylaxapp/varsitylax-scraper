// The test the rehearsal never had: run writeGames ITSELF, against the dump.
const dw = require('/Users/spencerwelch/Desktop/varsitylax/varsitylax-scraper/src/dual-write');
(async () => {
  // One fixture naming "Liberty" — the exact input that fires the ambiguous branch.
  const games = [{
    teamId: 'West Linn', opponent: 'Liberty', season: 2026, date: '2026-03-17',
    time: '4:30pm', isHome: true, isConference: false, isOT: false,
    teamScore: 9, oppScore: 8,
  }];
  try {
    const r = await dw.writeGames(games, 'ohsla');
    console.log('RESULT', JSON.stringify(r));
  } catch (e) {
    console.log('THREW:', e.message);
    console.log('STACK:', (e.stack || '').split('\n').slice(0, 4).join('\n'));
  }
  process.exit(0);
})();
