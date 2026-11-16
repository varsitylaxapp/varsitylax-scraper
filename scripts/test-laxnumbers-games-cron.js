#!/usr/bin/env node
// test-laxnumbers-games-cron.js — diff 8: the cron's LaxNumbers game job
// (src/laxnumbers-games/cron.js). No database, no network: the pool, the import and
// logScrape are fakes that record what they were asked to do.
const { gamesJobConfig, runLaxNumbersGames, SOURCE, READ_CAP } = require('../src/laxnumbers-games/cron');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `  — got ${got}`}`);
  if (!ok) failures++;
};
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const J = JSON.stringify;

function world({ importerThrows = null, connThrows = false } = {}) {
  const w = { sql: [], importerCalls: [], logs: [], released: 0, connections: 0, out: [] };
  w.pool = {
    getConnection: async () => {
      w.connections++;
      if (connThrows) throw new Error('connect ECONNREFUSED');
      return {
        beginTransaction: async () => w.sql.push('BEGIN'),
        rollback: async () => w.sql.push('ROLLBACK'),
        commit: async () => w.sql.push('COMMIT'),
        release: () => w.released++,
      };
    },
  };
  w.importer = async args => {
    w.importerCalls.push(args);
    if (importerThrows) throw new Error(importerThrows);
    const perState = {};
    for (const s of args.states) perState[s] = { teams: 3, skipped: 28, capped: 0, inserted: 1, updated: 0, filled: 0,
                                                 unresolved: s === 'MT' ? 1 : 0, identityConflicts: 0 };
    return { report: { perState } };
  };
  w.logScrape = async (...a) => w.logs.push(a);
  return w;
}

async function run(w, config) {
  const log = console.log, err = console.error;
  console.log = (...a) => w.out.push(a.join(' '));
  console.error = (...a) => w.out.push(a.join(' '));
  try {
    return await runLaxNumbersGames({ pool: w.pool, config, season: 2026, logScrape: w.logScrape, importer: w.importer });
  } catch (e) {
    return { thrown: e };     // the job must never do this; checks below see it
  } finally { console.log = log; console.error = err; }
}

(async () => {
  console.log('\n1. the flags');
  check('unset → off, dry', J(gamesJobConfig({})) === J({ states: [], commit: false }));
  check('blank → off', J(gamesJobConfig({ LAXNUMBERS_GAMES_STATES: ' ', LAXNUMBERS_GAMES_COMMIT: '' })) === J({ states: [], commit: false }));
  check('"id, mt" + 1 → [ID, MT], commit', J(gamesJobConfig({ LAXNUMBERS_GAMES_STATES: 'id, mt', LAXNUMBERS_GAMES_COMMIT: '1' })) === J({ states: ['ID', 'MT'], commit: true }));
  check('COMMIT=0 → dry run', gamesJobConfig({ LAXNUMBERS_GAMES_STATES: 'ID', LAXNUMBERS_GAMES_COMMIT: '0' }).commit === false);
  check('COMMIT=true → refused at boot', throws(() => gamesJobConfig({ LAXNUMBERS_GAMES_COMMIT: 'true' }), /must be 1/));
  check('Oregon → refused at boot', throws(() => gamesJobConfig({ LAXNUMBERS_GAMES_STATES: 'OR' }), /OR declares no laxnumbers game job/));
  check('unknown state → refused at boot', throws(() => gamesJobConfig({ LAXNUMBERS_GAMES_STATES: 'ID,XX' }), /unknown state "XX"/));

  console.log('\n2. OFF: nothing at all');
  let w = world(); let r = await run(w, gamesJobConfig({}));
  check('no connection, no import, no scrape_log', w.connections === 0 && w.importerCalls.length === 0 && w.sql.length === 0 && w.logs.length === 0, w.connections + ' connection(s)');
  check('one "off" line', w.out.length === 1 && /off \(LAXNUMBERS_GAMES_STATES unset\)/.test(w.out[0]), J(w.out));
  check('reports ran: false', r.ran === false);

  console.log('\n3. a dry run: rolled back, nothing logged');
  w = world(); r = await run(w, { states: ['ID'], commit: false });
  const a = w.importerCalls[0];
  check('import called once: ID, commit false, changed-only, season 2026', w.importerCalls.length === 1 &&
    J(a.states) === '["ID"]' && a.commit === false && a.changedOnly === true && a.season === 2026);
  check('no http override from the cron: live requests', !('http' in a));
  check('a dry run is capped at 40 reads', a.maxRequests === 40 && READ_CAP.dryRun === 40, a.maxRequests);
  check('…and says so', w.out.some(l => /dry run, changed-only, at most 40 reads/.test(l)), J(w.out));
  check('roster lock passed: OR and WA', J([...a.rosterLocked].sort()) === '["OR","WA"]', J([...a.rosterLocked]));
  check('inside BEGIN … ROLLBACK', J(w.sql) === '["BEGIN","ROLLBACK"]', J(w.sql));
  check('no scrape_log row on a dry run', w.logs.length === 0, J(w.logs));
  check('connection released', w.released === 1);
  check('says "dry run — would:"', w.out.some(l => /\[LaxNumbers games:ID\] ✓ dry run — would: read 3/.test(l)), J(w.out));

  console.log('\n4. a committing run: the core owns its transactions; one scrape_log row per state');
  w = world(); r = await run(w, { states: ['ID', 'MT'], commit: true });
  check('import called with commit true', w.importerCalls[0].commit === true);
  check('a committing run keeps the 160-read cap', w.importerCalls[0].maxRequests === 160, w.importerCalls[0].maxRequests);
  check('no transaction opened around it', w.sql.length === 0, J(w.sql));
  check(`scrape_log: ${SOURCE} ID success, MT partial (1 unresolved)`, J(w.logs.map(l => [l[0], l[4], l[2], l[1]])) ===
    J([[SOURCE, 'ID', 'success', 3], [SOURCE, 'MT', 'partial', 3]]), J(w.logs));
  check('message carries the counts', /read 3, unchanged 28, over the cap 0; insert 1/.test(w.logs[0][3]), w.logs[0][3]);

  console.log('\n5. failures never reach the cron');
  w = world({ importerThrows: 'LaxNumbers 403 for https://www.laxnumbers.com/team_info.php?y=2026&t=1' });
  r = await run(w, { states: ['ID', 'MT'], commit: true });
  check('a 403 resolves, does not throw', !r.thrown && r.ran === true && /403/.test(r.error?.message), r.thrown && 'threw: ' + r.thrown.message);
  check('…logged as an error row for each state', J(w.logs.map(l => [l[0], l[4], l[2]])) === J([[SOURCE, 'ID', 'error'], [SOURCE, 'MT', 'error']]), J(w.logs));
  check('…and connection released', w.released === 1);
  w = world({ importerThrows: 'boom' }); r = await run(w, { states: ['ID'], commit: false });
  check('dry-run failure: rolled back, nothing logged', J(w.sql) === '["BEGIN","ROLLBACK"]' && w.logs.length === 0, J(w.sql));
  w = world({ connThrows: true }); r = await run(w, { states: ['ID'], commit: true });
  check('no connection: resolves, error rows, nothing to release', !r.thrown && r.error && w.logs.length === 1 && w.released === 0, r.thrown ? 'threw: ' + r.thrown.message : J(w.logs));

  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
})();
