#!/usr/bin/env node
//
// test-laxnumbers-health.js — GET /api/v2/health/laxnumbers over seeded scrape_log rows.
// src/db is stubbed: no database, no network. The real router is mounted on an ephemeral
// port and called over HTTP, so status codes are what a monitor would see.
//
//   node scripts/test-laxnumbers-health.js
//
// EXIT 0 all cases pass · 1 a case failed

const path = require('path');
const http = require('http');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── stub src/db: rows per state, NEWEST FIRST, as scrape_log would return them ──
let seed = {};
const seen = [];
const t = (h) => new Date(Date.UTC(2026, 10, 12, h, 0, 0));   // Pacific wall time, as the DB stores it
const fakeDb = {
  execute: async (sql, params) => {
    seen.push({ sql, params });
    const state = params[0];
    const rows = (seed[state] || []).map((r, i) => ({ ...r, scraped_at: r.at ?? t(20 - i) }));
    if (/MAX\(scraped_at\)/.test(sql)) {
      const ok = rows.filter(r => r.status !== 'error').map(r => r.scraped_at);
      return [[{ at: ok.length ? ok[0] : null }]];
    }
    const limit = Number(sql.match(/LIMIT (\d+)/)[1]);
    return [rows.slice(0, limit)];
  },
};
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const express = require('express');
const app = express();
app.use('/api/v2', require('../src/api-v2'));
const { consecutiveFailures, httpStatusOf } = require('../src/scrape-health');

const get = (port) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/api/v2/health/laxnumbers' }, (res) => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(b) }));
  }).on('error', reject);
});
const ok = (n) => Array(n).fill({ status: 'success' });
const err = (n, msg = 'LaxNumbers 403 for https://www.laxnumbers.com/ratings/service?y=2026&v=3146') =>
  Array(n).fill({ status: 'error', error_message: msg });
const healthy = () => ({ OR: ok(3), WA: ok(3), AZ: ok(3), ID: ok(3), MT: ok(3), NV: ok(3) });

const server = app.listen(0, async () => {
  const port = server.address().port;
  try {
    console.log('\n1. counting (pure)');
    check('[] → 0', consecutiveFailures([]) === 0);
    check('e,e,s → 2', consecutiveFailures([{ status: 'error' }, { status: 'error' }, { status: 'success' }]) === 2);
    check('s,e,e,e → 0 (a success resets)', consecutiveFailures([{ status: 'success' }, ...err(3)]) === 0);
    check('partial is not a failure', consecutiveFailures([{ status: 'partial' }, ...err(3)]) === 0);
    check('skipped is not a failure', consecutiveFailures([{ status: 'skipped' }, ...err(3)]) === 0);
    check('status from "LaxNumbers 403 for <url>" → 403', httpStatusOf('LaxNumbers 403 for https://www.laxnumbers.com/x') === 403);
    check('status from axios "Request failed with status code 504" → 504', httpStatusOf('Request failed with status code 504') === 504);
    check('a timeout has no status → null', httpStatusOf('timeout of 15000ms exceeded') === null);
    check('digits in other text are not a status → null', httpStatusOf('connect ETIMEDOUT 104.26.0.1:443') === null
      && httpStatusOf('upstream said 403') === null && httpStatusOf(null) === null);

    console.log('\n2. over HTTP');
    seed = healthy();
    let r = await get(port);
    check('all healthy → 200, status ok, 6 states', r.code === 200 && r.body.status === 'ok' && r.body.states.length === 6
      && r.body.failing.length === 0, `${r.code} ${r.body.status}`);

    seed = { ...healthy(), ID: [...err(2), ...ok(5)] };
    r = await get(port);
    check('two failures in a row → still 200', r.code === 200 && r.body.states.find(s => s.state === 'ID').consecutiveFailedRuns === 2, `${r.code}`);

    seed = { ...healthy(), ID: [...err(3), ...ok(5)] };
    r = await get(port);
    const id = r.body.states.find(s => s.state === 'ID');
    check('three in a row → 503, status failing, failing [ID]', r.code === 503 && r.body.status === 'failing'
      && JSON.stringify(r.body.failing) === '["ID"]', `${r.code} ${JSON.stringify(r.body.failing)}`);
    check('…body has the last error\'s HTTP status and both timestamps with a real offset', id.lastErrorHttpStatus === 403
      && /-0[78]:00$/.test(id.lastErrorAt) && /-0[78]:00$/.test(id.lastSuccessAt), JSON.stringify(id));
    check('…and NO error text: no lastError key, no URL or message anywhere in the body',
      r.body.states.every(s => !('lastError' in s)) && !/laxnumbers\.com|LaxNumbers 403|ratings\/service/.test(JSON.stringify(r.body)),
      JSON.stringify(id));
    check('…exact per-state keys', Object.keys(id).sort().join() ===
      'consecutiveFailedRuns,lastErrorAt,lastErrorHttpStatus,lastSuccessAt,state', Object.keys(id).join());

    seed = { OR: err(3), WA: err(3), AZ: err(3), ID: err(3), MT: err(3), NV: err(3) };
    r = await get(port);
    check('the 2026-11-12 shape: all six blocked → 503, all six failing', r.code === 503 && r.body.failing.length === 6);
    check('…never succeeded: lastSuccessAt null', r.body.states.every(s => s.lastSuccessAt === null));

    seed = { ...healthy(), NV: [{ status: 'success' }, ...err(10)] };
    r = await get(port);
    check('a success after a long block resets to 0 → 200', r.code === 200 && r.body.states.find(s => s.state === 'NV').consecutiveFailedRuns === 0);

    seed = { ...healthy(), MT: err(40, 'x'.repeat(500)) };
    r = await get(port);
    const mt = r.body.states.find(s => s.state === 'MT');
    check('a long block is capped at the 25-row window, still ≥ 3', mt.consecutiveFailedRuns === 25 && r.code === 503);
    check('an error with no recognisable status → lastErrorHttpStatus null, text still absent',
      mt.lastErrorHttpStatus === null && !JSON.stringify(r.body).includes('xxxx'));

    seed = { ...healthy(), AZ: [...err(1, 'timeout of 15000ms exceeded'), ...ok(2)] };
    r = await get(port);
    const az = r.body.states.find(s => s.state === 'AZ');
    check('a timeout: lastErrorAt set, status null', az.lastErrorAt !== null && az.lastErrorHttpStatus === null, JSON.stringify(az));
    const or = r.body.states.find(s => s.state === 'OR');
    check('never errored: lastErrorAt and status both null', or.lastErrorAt === null && or.lastErrorHttpStatus === null, JSON.stringify(or));

    console.log('\n3. a database error');
    const realExec = fakeDb.execute;
    fakeDb.execute = async () => { throw new Error("ER_ACCESS_DENIED_ERROR: Access denied for user 'root'@'10.0.0.1'"); };
    const elog = console.error; console.error = () => {};
    try { r = await get(port); } finally { console.error = elog; fakeDb.execute = realExec; }
    check('→ 500 with a generic body, no database text', r.code === 500 && r.body.error === 'health check failed'
      && !/ER_ACCESS|root|10\.0\.0/.test(JSON.stringify(r.body)), JSON.stringify(r.body));

    console.log('\n4. query');
    const q = seen.find(s => /LIMIT/.test(s.sql));
    check('reads both rankings sources for the state', /source IN \(\?,\?\)/.test(q.sql)
      && q.params.slice(1).join() === 'laxnumbers,laxnumbers-v2', q.params.join());
    check('newest first', /ORDER BY id DESC/.test(q.sql));
  } catch (e) { check('no exception', false, e.stack); }
  server.close();
  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
});
