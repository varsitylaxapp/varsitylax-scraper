/**
 * The LaxNumbers game import, shared by scripts/import-laxnumbers-games.js and (later) the
 * cron. One run over one connection: build the indexes, run both phases, record the
 * unresolved tail. The caller owns the connection, the transaction and the report.
 */
const { buildIndexes } = require('./resolve');
const { runPhases } = require('./plan');
const { recordUnresolved } = require('./apply');

async function importLaxNumbersGames({ c, commit, season, states, rosterLocked }) {
  // A missing season is an error, never a silent 2026. Checked before any request.
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    throw new Error(`importLaxNumbersGames: season must be a year in 2000–2100, got ${JSON.stringify(season)}`);
  }
  const report = { perState: {}, unresolved: new Map() };

  const [teams] = await c.execute('SELECT id, slug, name, state FROM teams');
  const [aliases] = await c.execute('SELECT team_id, state, alias FROM team_aliases');

  const ctx = {
    c, commit, season, states, rosterLocked, report,
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
  return { ctx, report };
}

module.exports = { importLaxNumbersGames, recordUnresolved };
