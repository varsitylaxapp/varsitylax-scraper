#!/usr/bin/env node
/**
 * Did the rankings snapshots actually SURVIVE the write?
 *
 *   node scripts/assert-rankings-persisted.js --season=2026 --states=AZ,ID,MT,NV
 *   ./scripts/staging scripts/assert-rankings-persisted.js --season=2026 --states=AZ
 *
 * Exits non-zero if any (source, season, state) is missing or holds no entries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PROCESS — the snapshot that reported success, 2026-08-04.
 *
 * A window #4 rehearsal ran the rankings backfill for four states. Every state printed
 * `resolves ... unresolved: 0` and `=== ALL CHECKS PASSED ===`, including the writer's own
 * `PASS  snapshot exists for state — 1`. Minutes later, in the same container, the API
 * served 404 for three of the four. Arizona, written by the same loop moments earlier,
 * was fine.
 *
 * Nothing deletes snapshots. Nothing runs in between. The writes autocommit. The read path
 * is correctly scoped. Three delete-and-rewrite cycles on staging could not reproduce it.
 * ONE OCCURRENCE, NO MECHANISM.
 *
 * So this is CONTAINMENT, NOT EXPLANATION, and the shape of the containment follows from
 * the one thing the incident did prove: A WRITER'S OWN SUCCESS CHECK IS NOT EVIDENCE THE
 * ROW SURVIVED. It ran in the writer's process, on the writer's pool, and it passed in the
 * run where the rows were absent. A check that lives inside the thing it is checking can
 * only ever report that the thing believes itself.
 *
 * Hence: separate process, its own connection, its own [db] boot line.
 *
 * AND HENCE THE SERVER-IDENTITY BLOCK BELOW. Right now "the write was lost" and "the write
 * landed somewhere else" are indistinguishable — both look like a missing row. They call
 * for opposite responses, so the evidence has to separate them. Printing our own config
 * cannot: config is what we INTENDED. @@hostname, DATABASE() and @@port are what the
 * SERVER says about the connection it is actually serving, which is the only account that
 * settles where a row went. Both the writer and this assertion log it, so a recurrence
 * leaves two comparable records instead of one ambiguous absence.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const pool = require('../src/db');

const arg = (name, dflt) =>
  (process.argv.find(a => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=')[1];

const SOURCE = arg('source', 'laxnumbers');
const SEASON = parseInt(arg('season', '2026'));
const STATES = arg('states', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

(async () => {
  if (!STATES.length) {
    console.error('  --states is required, e.g. --states=AZ,ID,MT,NV');
    process.exit(2);
  }

  // Where the server says we are, not where we think we are. See the header.
  const [[id]] = await pool.execute(
    'SELECT @@hostname AS h, DATABASE() AS db, @@port AS port, CONNECTION_ID() AS cid');
  console.log(`  [assert] configured: ${pool.targetDescription}`);
  console.log(`  [assert] server says: hostname=${id.h} database=${id.db} port=${id.port} connection=${id.cid}`);
  console.log(`  [assert] ${SOURCE} / season ${SEASON} / ${STATES.join(', ')}\n`);

  const missing = [];
  for (const state of STATES) {
    const [[row]] = await pool.execute(
      `SELECT s.id, s.captured_at, COUNT(re.team_id) AS entries
         FROM rankings_snapshots s
    LEFT JOIN ranking_entries re ON re.snapshot_id = s.id
        WHERE s.source = ? AND s.season = ? AND s.state = ?
     GROUP BY s.id, s.captured_at
     ORDER BY s.captured_at DESC LIMIT 1`, [SOURCE, SEASON, state]);

    if (!row) {
      console.log(`    ${state}  MISSING — no snapshot row`);
      missing.push(`${state} (no snapshot)`);
    } else if (Number(row.entries) === 0) {
      // A snapshot with no entries serves 200 with an empty array — a pass that means
      // nothing. Same family as the WA checks that passed against an empty database.
      console.log(`    ${state}  EMPTY — snapshot ${row.id} exists but holds 0 entries`);
      missing.push(`${state} (snapshot ${row.id} empty)`);
    } else {
      console.log(`    ${state}  ok — snapshot ${row.id}, ${row.entries} entries, ` +
                  `captured ${row.captured_at.toISOString().slice(0, 19).replace('T', ' ')}`);
    }
  }

  if (missing.length) {
    console.log(`\n  ✗ PERSISTENCE ASSERTION FAILED: ${missing.join(', ')}`);
    console.log('    This is the 2026-08-04 anomaly. STOP THE WINDOW.');
    console.log('    Capture this output WITH the writer\'s own server-identity line — the');
    console.log('    two together are what distinguish a lost write from a misdirected one.\n');
    await pool.end();
    process.exit(1);
  }

  console.log(`\n  ✓ all ${STATES.length} snapshot(s) persisted, verified on a separate connection\n`);
  await pool.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
