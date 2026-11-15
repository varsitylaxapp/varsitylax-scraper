#!/usr/bin/env node
//
// test-laxnumbers-403-evidence.js — the LaxNumbers failure-path logging, with no network.
//
// impit and https.get are stubbed, so this touches neither LaxNumbers nor ipify nor any
// database. It goes through scrapeLaxNumbers(), the entry point the cron uses.
//
//   node scripts/test-laxnumbers-403-evidence.js
//
// Also covers the game import's bulk mode (quiet 200s), its required season, and the
// once-per-run IP line the cron prints whether LaxNumbers passed or failed.
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

  // ── 6. quiet mode (bulk team pages) ─────────────────────────────────────
  console.log('\n6. quiet mode: team pages');
  ln = fresh(); ipify.mode = 'ok';
  const page = '<table><tr><td>2026-03-04</td><td>19:00</td><td>at Borah</td><td></td><td>12 - 3</td></tr></table>';
  nextResponse = () => response(200, { 'cf-ray': 'q1-SJC' }, page);
  const rays = [];
  capture(); const g6 = await ln.scrapeLaxNumbersTeamGames(OR, 123, 2026, { quiet: true, onOk: (r) => rays.push(r) }); release();
  check('200 not logged in quiet mode', !logs.some((l) => l.includes('cf-ray=')), JSON.stringify(logs));
  check('onOk receives the cf-ray', rays.length === 1 && rays[0] === 'q1-SJC');
  check('page still parsed', g6.length === 1 && g6[0].teamScore === 12 && !g6[0].isHome);
  nextResponse = () => response(403, CF, BODY);
  capture(); err = null;
  try { await ln.scrapeLaxNumbersTeamGames(OR, 123, 2026, { quiet: true, onOk: () => rays.push('x') }); } catch (e) { err = e; }
  release();
  check('non-200 still logs full evidence when quiet', logs.some((l) => l.startsWith('[LaxNumbers] 403 ') && l.includes('cf-mitigated=challenge')));
  check('non-200 still throws the same message', err && /^LaxNumbers 403 for https:\/\/www\.laxnumbers\.com\/team_info\.php/.test(err.message));
  check('onOk not called on non-200', rays.length === 1);

  // ── 7. a missing season is an error, before any request ───────────────────
  console.log('\n7. season is required');
  const before = impitCalls.fetch.length;
  for (const [name, call] of [
    ['scrapeLaxNumbersTeamGames', () => ln.scrapeLaxNumbersTeamGames(OR, 123)],
    ['fetchLaxNumbersRatingsRaw', () => ln.fetchLaxNumbersRatingsRaw(OR)],
    ['fetchLaxNumbersRatingsRaw "2027" (string)', () => ln.fetchLaxNumbersRatingsRaw(OR, '2027')],
  ]) {
    let e7 = null; try { await call(); } catch (e) { e7 = e; }
    check(`${name} throws`, e7 && /season must be a year/.test(e7.message), e7 && e7.message);
  }
  const { importLaxNumbersGames } = require('../src/laxnumbers-games');
  let e8 = null, touched = false;
  try { await importLaxNumbersGames({ c: { execute: async () => { touched = true; return [[]]; } }, commit: false, states: ['ID'], rosterLocked: new Set() }); }
  catch (e) { e8 = e; }
  check('importLaxNumbersGames throws without a season', e8 && /season must be a year/.test(e8.message), e8 && e8.message);
  check('…before touching the database', !touched);
  check('no request made by any of them', impitCalls.fetch.length === before);

  // ── 8. the IP line on every cron run, pass or fail ───────────────────────
  console.log('\n8. once-per-run IP line');
  ln = fresh(); ipify.mode = 'ok';
  nextResponse = () => response(200, { 'cf-ray': 'ok8-SJC' }, rows);
  capture();
  for (let i = 0; i < 6; i++) await ln.scrapeLaxNumbers(OR);   // a passing run: six states
  await ln.logOutboundIpv4();                                    // what runAll() does after the loop
  await ln.logOutboundIpv4();
  release();
  check('passing run logs the IP once', logs.filter((l) => l === '[LaxNumbers] outbound IPv4=203.0.113.7').length === 1, JSON.stringify(logs.filter((l) => l.includes('IPv4'))));
  check('…with one lookup, IPv4, 5 s timeout', ipify.calls.length === 1 && ipify.calls[0].family === 4 && ipify.calls[0].timeout === 5000);

  ln = fresh(); ipify.mode = 'ok';
  nextResponse = () => response(403, CF, BODY);
  capture();
  for (let i = 0; i < 6; i++) { try { await ln.scrapeLaxNumbers(OR); } catch {} }
  await ln.logOutboundIpv4();
  release();
  check('failing run still logs it once, on stderr path, after the first evidence line',
    logs.filter((l) => l.includes('outbound IPv4=')).length === 1
      && logs.findIndex((l) => l.includes('outbound IPv4=')) === logs.findIndex((l) => l.startsWith('[LaxNumbers] 403 ')) + 1);
  check('…and the end-of-run call adds no lookup', ipify.calls.length === 1);

  for (const mode of ['error', 'timeout']) {
    ln = fresh(); ipify.mode = mode;
    capture(); let e9 = null; try { await ln.logOutboundIpv4(); } catch (e) { e9 = e; } release();
    check(`ipify ${mode}: never throws, logs unknown`, !e9 && logs.length === 1 && logs[0].startsWith('[LaxNumbers] outbound IPv4=unknown ('), logs[0]);
  }

  const idx = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const loopEnd = idx.indexOf("await logScrape('laxnumbers', 0, 'error'");
  const call = idx.indexOf('await logOutboundIpv4();');
  check('runAll() calls it after the LaxNumbers loop, before LaxPower',
    loopEnd > 0 && call > loopEnd && call < idx.indexOf('scrapeLaxPower()'));

  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
})();
