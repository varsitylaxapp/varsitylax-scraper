#!/usr/bin/env node
//
// test-laxnumbers-games-health.js — diff 9b: GET /api/v2/health/laxnumbers-games over
// seeded scrape_log rows. Every seeded row is built by the game job's own code
// (scripts/lib/laxnumbers-games-rows.js): its summary line, its success/partial rule, and
// its 403 message from the real error path. src/db is stubbed: no database, no network.
// The real router is mounted on an ephemeral port and called over HTTP.
//
//   node scripts/test-laxnumbers-games-health.js
//
// EXIT 0 all cases pass · 1 a case failed

const path = require('path');
const http = require('http');
// First, before anything loads src/scrapers/laxnumbers.js with the real client.
const { successRows, errorRows } = require('./lib/laxnumbers-games-rows');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const J = JSON.stringify;

// ── stub src/db. Rows per state, NEWEST FIRST. The SQL's time logic (the 7-day window and
// the 26-hour stale test) is the database's job; here a row says it directly: `old` rows
// are outside the 7-day window, `stale` is what the SQL would compute. The staging proof
// runs the real SQL.
let seed = {};
const seen = [];
const t = (h) => new Date(Date.UTC(2026, 10, 16, h, 0, 0));
const fakeDb = {
  execute: async (sql, params) => {
    seen.push({ sql, params });
    const state = params[0];
    const rows = (seed[state] || []).filter(r => !r.old)
      .map((r, i) => ({ ...r, scraped_at: r.at ?? t(20 - i), stale: r.stale ? 1 : 0 }));
    if (/MAX\(scraped_at\)/.test(sql)) {
      const ok = (seed[state] || []).filter(r => r.status !== 'error');
      return [[{ at: ok.length ? (ok[0].at ?? t(20)) : null }]];
    }
    return [rows.slice(0, Number(sql.match(/LIMIT (\d+)/)[1]))];
  },
};
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const zero = { teams: 6, skipped: 0, capped: 0, inserted: 0, updated: 44, filled: 0, unresolved: 0, identityConflicts: 0 };

(async () => {
  // ── rows from the job's own code ──
  const [plain] = await successRows({ MT: zero });
  const [capped] = await successRows({ WA: { ...zero, teams: 40, capped: 41, updated: 0 } });
  const [unres] = await successRows({ ID: { ...zero, teams: 31, unresolved: 2, updated: 167 } });
  const [ident] = await successRows({ NV: { ...zero, teams: 15, capped: 3, unresolved: 1, identityConflicts: 4 } });
  const errs = await errorRows(['MT', 'ID']);
  const err403 = errs[0];

  const express = require('express');
  const app = express();
  app.use('/api/v2', require('../src/api-v2'));
  const sh = require('../src/scrape-health');
  const { parseGamesSummary, httpStatusOf, GAMES_SOURCE } = sh;

  const server = app.listen(0, async () => {
    const port = server.address().port;
    const get = (p = '/api/v2/health/laxnumbers-games') => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, raw: b, body: JSON.parse(b) }));
      }).on('error', reject);
    });
    const ok = (n, row = plain) => Array(n).fill(row);
    const er = (n) => Array(n).fill(err403);
    const st = (r, code) => r.body.states.find(s => s.state === code);
    try {
      console.log('\n1. the rows the job writes (built by its own code)');
      check('a success row: source laxnumbers-games, status success', plain.source === GAMES_SOURCE && plain.status === 'success', J(plain));
      check('unresolved > 0 → the job writes status partial', unres.status === 'partial', unres.status);
      check('identity conflicts → partial, with the suffix', ident.status === 'partial' && /, identity conflicts 4$/.test(ident.error_message), ident.error_message);
      check('the 403 row: status error, the scraper\'s own message', err403.status === 'error'
        && /^LaxNumbers 403 for https:\/\/www\.laxnumbers\.com\/ratings\/service\?y=2026&v=\d+$/.test(err403.error_message), err403.error_message);
      check('…one error row per state, as the job writes them', J(errs.map(e => [e.state, e.status])) === J([['MT', 'error'], ['ID', 'error']]), J(errs));

      console.log('\n2. the summary pattern parses those lines (pure)');
      check('plain → every count back', J(parseGamesSummary(plain.error_message)) === J(zero), J(parseGamesSummary(plain.error_message)));
      check('capped 41 → capped 41', parseGamesSummary(capped.error_message)?.capped === 41, capped.error_message);
      check('unresolved 2 → unresolved 2', parseGamesSummary(unres.error_message)?.unresolved === 2, unres.error_message);
      check('with the identity-conflicts suffix → all counts back', J(parseGamesSummary(ident.error_message)) ===
        J({ ...zero, teams: 15, capped: 3, unresolved: 1, identityConflicts: 4, updated: 44 }), J(parseGamesSummary(ident.error_message)));
      check('the 403 message → null', parseGamesSummary(err403.error_message) === null);
      check('a drifted line (one word renamed) → null', parseGamesSummary(plain.error_message.replace('over the cap', 'over cap')) === null);
      check('a line with text after it → null', parseGamesSummary(plain.error_message + ' (dry run)') === null);
      check('empty, null → null', parseGamesSummary('') === null && parseGamesSummary(null) === null);
      check('the 403 message gives HTTP status 403', httpStatusOf(err403.error_message) === 403);

      console.log('\n3. over HTTP');
      seed = {};
      let r = await get();
      check('job off (no rows) → 200, status ok, no states', r.code === 200 && r.body.status === 'ok' && r.body.states.length === 0
        && r.body.threshold === 3 && J(r.body.failing) === '[]', `${r.code} ${r.raw}`);

      seed = { AZ: ok(3) };
      r = await get();
      const az = st(r, 'AZ');
      check('0 failures → 200; only the state with rows is listed', r.code === 200 && r.body.states.length === 1 && az.consecutiveFailedRuns === 0, r.raw);
      check('…flags: overCap false, unresolved 0, missedDailyPass false', az.overCapLastRun === false && az.unresolvedLastRun === 0 && az.missedDailyPass === false, J(az));
      check('…exact per-state keys', Object.keys(az).join() ===
        'state,consecutiveFailedRuns,lastSuccessAt,lastErrorAt,lastErrorHttpStatus,overCapLastRun,unresolvedLastRun,missedDailyPass', Object.keys(az).join());

      seed = { ID: [...er(2), ...ok(3)] };
      r = await get();
      check('2 failures → still 200', r.code === 200 && st(r, 'ID').consecutiveFailedRuns === 2, `${r.code} ${r.raw}`);
      check('…newest row an error → overCap and unresolved null', st(r, 'ID').overCapLastRun === null && st(r, 'ID').unresolvedLastRun === null, J(st(r, 'ID')));

      seed = { AZ: ok(3), MT: [...er(3), ...ok(2)] };
      r = await get();
      const mt = st(r, 'MT');
      check('3 failures → 503, status failing, failing [MT]', r.code === 503 && r.body.status === 'failing' && J(r.body.failing) === '["MT"]', `${r.code} ${r.raw}`);
      check('…lastErrorHttpStatus 403, times with a real offset', mt.lastErrorHttpStatus === 403 && /-0[78]:00$/.test(mt.lastErrorAt) && /-0[78]:00$/.test(mt.lastSuccessAt), J(mt));
      check('…NO error text anywhere in the body', !/laxnumbers\.com|LaxNumbers 403|ratings\/service|read \d|unchanged/.test(r.raw), r.raw);

      seed = { NV: [{ ...plain, stale: true }] };
      r = await get();
      check('stale (newest row > 26 h) → missedDailyPass true, still 200', r.code === 200 && st(r, 'NV').missedDailyPass === true, `${r.code} ${r.raw}`);

      seed = { WA: [capped, ...ok(2)] };
      r = await get();
      check('over the cap → overCapLastRun true, still 200', r.code === 200 && st(r, 'WA').overCapLastRun === true, `${r.code} ${r.raw}`);

      seed = { ID: [unres] };
      r = await get();
      check('a partial run, unresolved 2 → unresolvedLastRun 2, not a failure, 200', r.code === 200
        && st(r, 'ID').unresolvedLastRun === 2 && st(r, 'ID').consecutiveFailedRuns === 0, `${r.code} ${r.raw}`);

      seed = { AZ: [{ ...plain, error_message: plain.error_message.replace('over the cap', 'over cap') }, ...ok(2)] };
      r = await get();
      check('a summary that does not match → flags null, never text, 200', r.code === 200 && st(r, 'AZ').overCapLastRun === null
        && st(r, 'AZ').unresolvedLastRun === null && !/over cap|read \d/.test(r.raw), r.raw);

      seed = { WA: [{ ...capped, stale: true }], ID: [unres], NV: [{ ...ident, stale: true }] };
      r = await get();
      check('every flag on, no failures → 200 (flags never cause a 503)', r.code === 200 && r.body.status === 'ok' && r.body.failing.length === 0, `${r.code} ${r.raw}`);

      seed = { MT: [...er(3).map(x => ({ ...x, old: true }))] };
      r = await get();
      check('3 failures older than 7 days → not listed, 200 (what clears a switched-off state)', r.code === 200 && r.body.states.length === 0, r.raw);

      seed = { MT: [...ok(1), ...er(3)] };
      r = await get();
      check('a good run after 3 failures → 0, 200 (the other thing that clears it)', r.code === 200 && st(r, 'MT').consecutiveFailedRuns === 0, r.raw);

      console.log('\n4. a database error');
      const realExec = fakeDb.execute;
      fakeDb.execute = async () => { throw new Error("ER_ACCESS_DENIED_ERROR: Access denied for user 'root'@'10.0.0.1'"); };
      const elog = console.error; console.error = () => {};
      try { r = await get(); } finally { console.error = elog; fakeDb.execute = realExec; }
      check('→ 500 with a generic body, no database text', r.code === 500 && r.body.error === 'health check failed'
        && !/ER_ACCESS|root|10\.0\.0/.test(r.raw), r.raw);

      console.log('\n5. query and scope');
      seen.length = 0; seed = {}; await get();
      const qs = seen.filter(s => /LIMIT/.test(s.sql));
      check('asks only the game-job states, in registry order: WA, AZ, ID, MT, NV', J(qs.map(q => q.params[0])) === '["WA","AZ","ID","MT","NV"]', J(qs.map(q => q.params[0])));
      check('reads only source laxnumbers-games', qs.every(q => q.params[1] === 'laxnumbers-games' && !/IN \(/.test(q.sql)));
      check('newest first, last 7 days, stale at 26 h, by the database clock', /ORDER BY id DESC/.test(qs[0].sql)
        && /NOW\(\) - INTERVAL 7 DAY/.test(qs[0].sql) && /NOW\(\) - INTERVAL 26 HOUR/.test(qs[0].sql), qs[0].sql);
      seed = { OR: er(3), WA: ok(1), AZ: ok(1), ID: ok(1), MT: ok(1), NV: ok(1) };
      r = await get('/api/v2/health/laxnumbers');
      check('the existing /health/laxnumbers still answers on its own sources', r.code === 503 && J(r.body.failing) === '["OR"]'
        && !('overCapLastRun' in r.body.states[0]), `${r.code} ${r.raw.slice(0, 120)}`);
    } catch (e) { check('no exception', false, e.stack); }
    server.close();
    console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
    process.exit(failures ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(1); });
