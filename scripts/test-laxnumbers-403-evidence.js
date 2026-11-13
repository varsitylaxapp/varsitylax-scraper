#!/usr/bin/env node
//
// test-laxnumbers-403-evidence.js — the LaxNumbers failure-path logging, with no network.
//
// impit and https.get are stubbed, so this touches neither LaxNumbers nor ipify nor any
// database. It goes through scrapeLaxNumbers(), the entry point the cron uses.
//
//   node scripts/test-laxnumbers-403-evidence.js
//
// EXIT 0 all cases pass · 1 a case failed

const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── stubs ────────────────────────────────────────────────────────────────────
const impitCalls = { ctor: [], fetch: [] };
let nextResponse;
class FakeImpit {
  constructor(opts) { impitCalls.ctor.push(opts); }
  async fetch(url, opts) { impitCalls.fetch.push({ url, opts }); return nextResponse(); }
}
const impitPath = require.resolve('impit');
require.cache[impitPath] = { id: impitPath, filename: impitPath, loaded: true, exports: { Impit: FakeImpit } };

function response(status, headers, body) {
  let textCalls = 0;
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
    text: async () => { textCalls++; return body; },
    json: async () => JSON.parse(body),
    get textCalls() { return textCalls; },
  };
}

let ipify = { calls: [], mode: 'ok' };
https.get = (opts, cb) => {
  ipify.calls.push(opts);
  const req = new EventEmitter();
  req.destroy = (e) => setImmediate(() => req.emit('error', e));
  setImmediate(() => {
    if (ipify.mode === 'error') return req.emit('error', new Error('getaddrinfo ENOTFOUND api4.ipify.org'));
    if (ipify.mode === 'timeout') return req.emit('timeout');
    const res = new EventEmitter(); res.statusCode = 200;
    cb(res); res.emit('data', '203.0.113.7\n'); res.emit('end');
  });
  return req;
};

let logs = [];
const origLog = console.log, origErr = console.error;
const capture = () => { logs = []; console.log = (...a) => logs.push(a.join(' ')); console.error = console.log; };
const release = () => { console.log = origLog; console.error = origErr; };

const modPath = path.join(__dirname, '..', 'src', 'scrapers', 'laxnumbers.js');
const fresh = () => { delete require.cache[modPath]; ipify.calls = []; return require(modPath); };
const { getState } = require('../src/config/states');
const OR = getState('OR');
const URL_ = `https://www.laxnumbers.com/ratings/service?y=2026&v=${OR.laxnumbersId}`;
const REF = `https://www.laxnumbers.com/ratings.php?y=2026&v=${OR.laxnumbersId}`;

const CF = { 'cf-mitigated': 'challenge', 'cf-ray': 'abc123-SJC', server: 'cloudflare' };
const BODY = '<!DOCTYPE html><title>Just a moment...</title>' + 'x'.repeat(500);

(async () => {
  // ── 1. a 403 ──────────────────────────────────────────────────────────────
  console.log('\n1. stubbed 403 with Cloudflare headers');
  let ln = fresh(); ipify.mode = 'ok';
  nextResponse = () => response(403, CF, BODY);
  capture(); let err; try { await ln.scrapeLaxNumbers(OR); } catch (e) { err = e; } release();
  logs.forEach((l) => console.log('      | ' + l.slice(0, 160) + (l.length > 160 ? '…' : '')));
  check('throws the byte-identical scrape_log message', err && err.message === `LaxNumbers 403 for ${URL_}`, err && err.message);
  const ev = logs.find((l) => l.startsWith('[LaxNumbers] 403 '));
  check('evidence line has status and URL', !!ev && ev.includes(`403 ${URL_}`));
  check('evidence line has cf-mitigated, cf-ray, server', !!ev && ev.includes('cf-mitigated=challenge') && ev.includes('cf-ray=abc123-SJC') && ev.includes('server=cloudflare'));
  const logged = ev && JSON.parse(ev.slice(ev.indexOf('body=') + 5));
  check('body is the first 300 characters', logged === BODY.slice(0, 300), `${logged && logged.length} chars`);
  check('outbound IPv4 logged', logs.includes('[LaxNumbers] outbound IPv4=203.0.113.7'));
  check('ipify asked once, IPv4, 5 s timeout', ipify.calls.length === 1 && ipify.calls[0].family === 4 && ipify.calls[0].timeout === 5000 && ipify.calls[0].host === 'api4.ipify.org');
  check('no retry: one LaxNumbers request', impitCalls.fetch.length === 1);

  // ── 2. the other five states fail in the same run ─────────────────────────
  console.log('\n2. five more 403s in the same process');
  capture(); for (let i = 0; i < 5; i++) { try { await ln.scrapeLaxNumbers(OR); } catch {} } release();
  check('IPv4 looked up once per run', ipify.calls.length === 1, `${ipify.calls.length} lookups`);
  check('IPv4 line not repeated', logs.filter((l) => l.includes('outbound IPv4=')).length === 0);
  check('each failure still logs its evidence', logs.filter((l) => l.startsWith('[LaxNumbers] 403 ')).length === 5);

  // ── 3. the IP lookup itself fails ─────────────────────────────────────────
  for (const mode of ['error', 'timeout']) {
    console.log(`\n3. ipify ${mode}`);
    ln = fresh(); ipify.mode = mode;
    capture(); err = null; try { await ln.scrapeLaxNumbers(OR); } catch (e) { err = e; } release();
    const ipLine = logs.find((l) => l.includes('outbound IPv4='));
    check('lookup never throws; the LaxNumbers error is what surfaces', err && err.message === `LaxNumbers 403 for ${URL_}`);
    check('logs unknown with the reason', !!ipLine && ipLine.includes('unknown ('), ipLine);
  }

  // ── 4. a 200 ──────────────────────────────────────────────────────────────
  console.log('\n4. stubbed 200');
  ln = fresh(); ipify.mode = 'ok';
  const rows = JSON.stringify([{ name: 'Oregon Episcopal', ranking: 1, wins: 17, losses: 1, rating: 83.9, agd: 6.2, sched: 77.6 }]);
  let r200; nextResponse = () => (r200 = response(200, { 'cf-ray': 'ok999-SJC', server: 'cloudflare' }, rows));
  capture(); const out = await ln.scrapeLaxNumbers(OR); release();
  check('logs cf-ray only', logs.includes('[LaxNumbers] 200 cf-ray=ok999-SJC') && !logs.some((l) => /cf-mitigated|server=|outbound/.test(l)));
  check('no IP lookup on success', ipify.calls.length === 0);
  check('body left for the caller', r200.textCalls === 0 && out.length === 1 && out[0].teamName === 'Oregon Episcopal');

  // ── 5. request unchanged ─────────────────────────────────────────────────
  console.log('\n5. request and client settings unchanged');
  check('impit settings', impitCalls.ctor.every((o) => JSON.stringify(o) === '{"browser":"chrome","timeout":20000}'), JSON.stringify(impitCalls.ctor[0]));
  check('request headers', impitCalls.fetch.every((f) => f.url === URL_ && JSON.stringify(f.opts) === JSON.stringify({ headers: { Referer: REF } })));

  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
})();
