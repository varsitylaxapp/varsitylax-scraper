#!/usr/bin/env node
// One-off LaxNumbers rankings scrape for a single state. STAGING ONLY.
// Usage: node scripts/scrape-state-rankings.js WA --target=staging [--commit]
//
// Exists because "capability true, data absent" is a real product state and we
// need it NOT to be the state Washington sits in during iOS development. The
// WHSBLA import seeded teams, games and classifications; rankings were never
// part of it, so /rankings/laxnumbers?state=WA returns 404 while
// /api/v2/states advertises hasRankings: true.
//
// This is a ONE-OFF, not a schedule. It does not enable the state in the prod
// scraper — that is a stage (c) decision. `enabled: false` in the registry is
// untouched, so the prod cron keeps scraping Oregon alone.
require('dotenv').config();
const db = require('../src/db');
const { getState, isValidState } = require('../src/config/states');
const { scrapeLaxNumbers } = require('../src/scrapers/laxnumbers');
const dualWrite = require('../src/dual-write');

const CODE = (process.argv[2] || '').toUpperCase();
const COMMIT = process.argv.includes('--commit');
const q = async (s, p = []) => (await db.execute(s, p))[0];

(async () => {
  // STAGING BY DEFAULT, PROD ONLY WITH --stage-c.
  //
  // The guard exists to stop an ACCIDENTAL production import, and that is still worth
  // stopping — this script writes a whole state's season. What it must not do is make a
  // DELIBERATE, rehearsed production run impossible, which is what stage (c) / window #3
  // is. So prod requires naming the operation explicitly; a bare invocation still cannot
  // reach it, and `rehearsal` (the Docker gate) passes as before.
  const STAGE_C = process.argv.includes('--stage-c');
  if (db.targetLabel === 'prod' && !STAGE_C) {
    console.error(`FATAL: resolved target is "prod". Pass --stage-c to run the ` +
      `Washington promotion against production deliberately.`);
    process.exit(1);
  }
  if (db.targetLabel !== 'staging' && !(db.targetLabel === 'prod' && STAGE_C)
      && db.targetLabel !== 'rehearsal') {
    console.error(`FATAL: target is "${db.targetLabel}". This one-off runs against staging only.`);
    process.exit(1);
  }
  if (!isValidState(CODE)) {
    console.error(`FATAL: unknown state "${CODE}". Pass a registered code, e.g. WA.`);
    process.exit(1);
  }
  const st = getState(CODE);
  console.log(`\n=== scrape-state-rankings ${CODE} ===`);
  console.log(`target: ${db.targetDescription}`);
  console.log(`mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN'}   laxnumbersId=${st.laxnumbersId}`);
  console.log(`registry enabled flag: ${st.enabled} (unchanged — prod cron unaffected)\n`);

  const before = {
    snapshots: (await q('SELECT COUNT(*) n FROM rankings_snapshots'))[0].n,
    forState:  (await q('SELECT COUNT(*) n FROM rankings_snapshots WHERE state=?', [CODE]))[0].n,
    entries:   (await q('SELECT COUNT(*) n FROM ranking_entries'))[0].n,
    unresolved:(await q('SELECT COUNT(*) n FROM unresolved_aliases'))[0].n,
    teams:     (await q('SELECT COUNT(*) n FROM teams'))[0].n,
  };
  console.log('before:', JSON.stringify(before));

  const rankings = await scrapeLaxNumbers(st);
  console.log(`\nfeed returned ${rankings.length} rows`);

  // Resolution preview: which feed names will land, which will not.
  const aliases = await q(
    `SELECT ta.alias_normalized a, t.id, t.slug, t.name
     FROM team_aliases ta JOIN teams t ON t.id = ta.team_id WHERE t.state = ?`, [CODE]);
  const { normalizeAlias } = require('../src/normalize');
  const idx = new Map(aliases.map(r => [r.a, r]));
  const hit = [], miss = [];
  for (const r of rankings) {
    (idx.has(normalizeAlias(r.teamName)) ? hit : miss).push(r.teamName);
  }
  console.log(`resolves against ${CODE} aliases: ${hit.length}   unresolved: ${miss.length}`);
  if (miss.length) {
    console.log('UNRESOLVED (will be logged, not guessed):');
    miss.forEach(n => console.log(`    ? ${n}`));
  }

  if (!COMMIT) { console.log('\n(dry run — nothing written)'); await db.end(); return; }

  const r = await dualWrite.writeRankings('laxnumbers', rankings, CODE);
  console.log(`\nwriteRankings -> snapshot=${r.snapshotId ?? 'unchanged/skipped'} entries=${r.entries} unresolved=${r.unresolved.length}`);

  const after = {
    snapshots: (await q('SELECT COUNT(*) n FROM rankings_snapshots'))[0].n,
    forState:  (await q('SELECT COUNT(*) n FROM rankings_snapshots WHERE state=?', [CODE]))[0].n,
    entries:   (await q('SELECT COUNT(*) n FROM ranking_entries'))[0].n,
    unresolved:(await q('SELECT COUNT(*) n FROM unresolved_aliases'))[0].n,
    teams:     (await q('SELECT COUNT(*) n FROM teams'))[0].n,
  };
  console.log('after: ', JSON.stringify(after));
  console.log('delta: ', JSON.stringify(Object.fromEntries(
    Object.keys(after).map(k => [k, after[k] - before[k]]))));

  const checks = [
    ['no team rows created (roster lock)', after.teams === before.teams, `${after.teams - before.teams}`],
    ['snapshot exists for state', after.forState > 0, `${after.forState}`],
    ['no blank-state snapshots', (await q("SELECT COUNT(*) n FROM rankings_snapshots WHERE state=''"))[0].n === 0, ''],
    ['every entry joins a team of this state',
      (await q(`SELECT COUNT(*) n FROM ranking_entries re
                JOIN rankings_snapshots s ON s.id=re.snapshot_id
                JOIN teams t ON t.id=re.team_id
                WHERE s.state=? AND t.state<>?`, [CODE, CODE]))[0].n === 0, ''],
    ['Oregon snapshots untouched',
      (await q("SELECT COUNT(*) n FROM rankings_snapshots WHERE state='OR'"))[0].n === 8, ''],
  ];
  console.log('\n--- CHECKS ---');
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!pass) ok = false;
  }
  console.log(`\n=== ${ok ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} ===\n`);
  await db.end();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
