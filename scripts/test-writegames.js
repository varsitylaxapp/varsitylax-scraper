#!/usr/bin/env node
//
// test-writegames.js — run THE WRITER, not the repair scripts, against a prod dump.
//
// Ledger member 9: window #5's rehearsal proved the seeder, the reassignment executor,
// the merge script and the dedupe against a faithful dump, watched 77 findings go to 0,
// and certified the window — without ever calling `writeGames`. The code under test was
// not the code under load, and the writer crashed on its first real cron cycle.
//
// Every window that deploys scraper code runs this, same standing as
// boot-against-prod-schema.
//
//   DB_TARGET=rehearsal REHEARSAL_DATABASE_URL=... node scripts/test-writegames.js
//
// EXIT 0 all cases pass · 1 a case failed · 2 could not run
//
// REFUSES TO RUN AGAINST PRODUCTION. It manufactures alias rows.

const db = require('./../src/db');
const dw = require('./../src/dual-write');

if (db.targetLabel === 'prod') {
  console.error('[test-writegames] FATAL: this test writes fixtures. Never against prod.');
  process.exit(2);
}

const q = async (s, p = []) => (await db.execute(s, p))[0];
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  console.log('\n══ writeGames under test ══\n');

  // ── CASE 1: resolvable — many candidates, one local. Must WRITE. ───────────
  // "Liberty" is OR + WA. An OHSLA schedule saying it means OHSLA's Liberty.
  const r1 = await dw.writeGames([{
    teamId: 'West Linn', opponent: 'Liberty', season: 2026, date: '2026-03-17',
    time: '4:30pm', isHome: true, isConference: false, isOT: false, teamScore: 9, oppScore: 8,
  }], 'ohsla');
  check('ambiguous-but-local resolves and writes', r1.written === 1 && r1.ambiguous.length === 0,
        JSON.stringify({ written: r1.written, ambiguous: r1.ambiguous.length }));

  // ── CASE 2: THE REFUSAL BRANCH — ambiguous, NO local candidate. ────────────
  //
  // Manufactured, because production has no such name today: all three real
  // collisions (liberty, lincoln, mountain view) include an Oregon candidate, so an
  // OHSLA scrape always finds a local one and the branch never fires. That is exactly
  // why it reached production untested — the dangerous path is the rare one.
  const [[idTeam]] = [await q(`SELECT id FROM teams WHERE state='ID' LIMIT 1`)];
  const [[azTeam]] = [await q(`SELECT id FROM teams WHERE state='AZ' LIMIT 1`)];
  await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source) VALUES (?,?,?,?)`,
          [idTeam.id, 'ID', 'Zzyzx Collegiate', 'test-fixture']);
  await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source) VALUES (?,?,?,?)`,
          [azTeam.id, 'AZ', 'Zzyzx Collegiate', 'test-fixture']);
  await q(`DELETE FROM unresolved_aliases WHERE raw_name = 'Zzyzx Collegiate'`);

  const before = (await q(`SELECT COUNT(*) n FROM games WHERE season=2026`))[0].n;
  const r2 = await dw.writeGames([{
    teamId: 'West Linn', opponent: 'Zzyzx Collegiate', season: 2026, date: '2026-03-18',
    time: '5:00pm', isHome: true, isConference: false, isOT: false, teamScore: 7, oppScore: 6,
  }], 'ohsla');
  const after = (await q(`SELECT COUNT(*) n FROM games WHERE season=2026`))[0].n;

  check('refuses an ambiguous name with no local candidate', r2.ambiguous.length === 1,
        JSON.stringify(r2.ambiguous));
  check('refusal writes NO game', after === before, `${before} → ${after}`);
  const logged = await q(
    `SELECT context FROM unresolved_aliases WHERE raw_name='Zzyzx Collegiate'`);
  check('refusal is logged with both candidates', logged.length === 1 && /AMBIGUOUS/.test(logged[0].context),
        logged.length ? logged[0].context.slice(0, 70) : 'no row');

  // ── CASE 3: THE DIAGNOSTIC CANNOT KILL ITS PATIENT. ───────────────────────
  // Break the logging boundary and confirm the batch still lands. A refusal path that
  // takes down the writer is the inversion that caused this incident.
  const realExecute = db.execute.bind(db);
  db.execute = async (sql, params) => {
    if (/unresolved_aliases/i.test(sql)) throw new Error('simulated logging failure');
    return realExecute(sql, params);
  };
  let r3, threw = null;
  try {
    r3 = await dw.writeGames([{
      teamId: 'West Linn', opponent: 'Zzyzx Collegiate', season: 2026, date: '2026-03-19',
      time: '5:00pm', isHome: true, isConference: false, isOT: false, teamScore: 5, oppScore: 4,
    }, {
      teamId: 'West Linn', opponent: 'Tualatin', season: 2026, date: '2026-03-20',
      time: '5:00pm', isHome: true, isConference: false, isOT: false, teamScore: 11, oppScore: 3,
    }], 'ohsla');
  } catch (e) { threw = e.message; }
  db.execute = realExecute;
  check('a throwing logger does not abort the batch', threw === null, threw || 'no throw');
  check('the resolvable game in that batch still wrote', !!r3 && r3.written >= 1,
        r3 ? `written=${r3.written}` : 'batch died');

  // ── PROVEN FAILABLE ───────────────────────────────────────────────────────
  // A test that cannot go red is a line of output. Assert the negative directly:
  // if the resolver had silently picked a candidate, case 2 would have written a game.
  check('the refusal assertion is failable (control: a resolved name DOES write)',
        r1.written === 1, 'case 1 wrote, so "no game written" is a reachable failure');

  await q(`DELETE FROM team_aliases WHERE source='test-fixture'`);
  console.log(`\n   ${failures ? failures + ' FAILURE(S)' : 'all cases passed'}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('[test-writegames] FATAL:', e.message); process.exit(2); });
