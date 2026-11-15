/**
 * The LaxNumbers game import, shared by scripts/import-laxnumbers-games.js and (later) the
 * cron. One run over one connection: build the indexes, run both phases, record the
 * unresolved tail, then age out dead fixtures and refresh win-loss.
 *
 * TRANSACTIONS ARE OURS ON COMMIT. Rosters are one transaction; each state's games are
 * one more, written only after every team page has been fetched. The caller must not
 * hold an open transaction on `c` when commit is true. A dry run writes nothing at all.
 */
const { buildIndexes } = require('./resolve');
const { runPhases } = require('./plan');
const { recordUnresolved } = require('./apply');
const { loadOverrides } = require('./time');
// Live requests, nothing recorded: what the cron will do. (Defined here, not taken from
// fetch.js, so a test that stubs fetch.js still gets a default.)
const LIVE = { mode: 'live', dir: null, spacingMs: 120 };

async function importLaxNumbersGames({ c, commit, season, states, rosterLocked, strictRulings = true,
                                       http = LIVE }) {
  // A missing season is an error, never a silent 2026. Checked before any request.
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    throw new Error(`importLaxNumbersGames: season must be a year in 2000–2100, got ${JSON.stringify(season)}`);
  }
  const report = { perState: {}, unresolved: new Map() };

  const [teams] = await c.execute('SELECT id, slug, name, state FROM teams');
  const [aliases] = await c.execute('SELECT team_id, state, alias FROM team_aliases');

  const ctx = {
    c, commit, season, states, rosterLocked, strictRulings, report, http,
    counter: { requests: 0 },
    zoneOverrides: loadOverrides(),
    ix: buildIndexes(teams, aliases),
    // Dry run SIMULATES creation — assigning a provisional id and indexing it — so the
    // count ladder below reflects what a commit would actually do. Without this every
    // opponent stays unresolved in dry run and the numbers describe nothing.
    fakeId: -1,
    // EVERY GAME APPEARS ON BOTH TEAMS' PAGES. Without an in-run guard the importer sees
    // each one twice: in COMMIT the second lookup finds the row just written, but in DRY
    // RUN nothing is written, so the prediction came out ~2x the truth — which is exactly
    // the number a production window would have been planned against.
    seenThisRun: new Set(),
  };

  await runPhases(ctx);

  if (commit) await c.beginTransaction();
  try {
    await recordUnresolved(ctx);
    // Dead fixtures this source owns: the shared rule (src/stale-fixtures.js).
    const { markStaleFixtures } = require('../stale-fixtures');
    const stale = await markStaleFixtures(c, season, { source: 'laxnumbers', dryRun: !commit });
    console.log(`  stale: ${commit ? '' : 'would mark '}${stale.marked ?? stale.rows.length} laxnumbers fixture(s) stale`);
    report.stale = stale;
    if (commit) await c.commit();
  } catch (err) {
    if (commit) await c.rollback();
    throw err;
  }
  // Records follow the games. Season passed in, never the module default.
  if (commit) {
    const { refreshWinLoss } = require('../dual-write');
    await refreshWinLoss(season);
    console.log(`  win-loss refreshed for ${season}`);
  }
  console.log(`  LaxNumbers requests this run: ${ctx.counter.requests}` +
              (http.mode === 'replay' ? ` (replayed from ${http.dir})` : http.mode === 'record' ? ` (recorded to ${http.dir})` : ''));
  return { ctx, report };
}

module.exports = { importLaxNumbersGames, recordUnresolved };
