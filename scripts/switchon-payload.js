#!/usr/bin/env node
/**
 * The LaxNumbers game job's switch-on: each stage's expected API diff, captured and asserted.
 *
 *   node scripts/switchon-payload.js capture <dir> <apiBase>
 *   node scripts/switchon-payload.js compare <beforeDir> <afterDir> --state <ST>
 *                                    [--expect-games N] [--ids-out <file>]
 *
 * CAPTURE is window6-payload.js's: every v2 read endpoint for the six states (status and
 * body), and the schedule of every team those endpoints name.
 *
 * COMPARE passes only when the one difference anywhere is `datetime` going from null to a
 * timestamp on a game of the stage's state. "Of the stage's state" means its id is in the
 * BEFORE capture's /schedule/all?state=<ST>. Games are matched by id wherever they appear
 * (the same database before and after, so ids are stable); anything else is compared
 * positionally, and key order counts. So all of these fail:
 *   - any other field changing (a score, a status, a flag);
 *   - an existing time changing, or a time going back to null;
 *   - a time appearing on a game outside the stage;
 *   - a game added or removed anywhere, or a list of games in a different order;
 *   - a response added or removed, or a status code changing.
 *
 * CROSS-BORDER games are in two states' schedules, so the state rule alone would let either
 * stage fill them. They are pinned to the stage that fills them in the approved order
 * (MT → NV → AZ → ID → WA): at any other stage a time appearing on one fails.
 *
 * --expect-games N fails when the count of games that gained a time is more than 10% off N
 * (the approved stop condition); N = 0 means exactly zero. --ids-out writes those ids, one
 * per line.
 *
 * An ORDER difference is reported on its own line. It is never allowed: if a time appearing
 * reorders a list, that is a decision for a person, not for this script.
 */
const fs = require('fs');
const path = require('path');

const STATES = ['OR', 'WA', 'AZ', 'ID', 'MT', 'NV'];
const SEASON = 2026;
const VOLATILE = new Set(['updated', 'lastScrape', 'lastGameWrite', 'lastSnapshot', 'scrapedAt', 'scraped_at']);
// Measured 2026-11-16 on the window-6 container: the only WA games that gain a time.
const CROSS_BORDER = new Map([
  [96960, 'NV'],   // Tahoma (WA) v Coronado (NV)
  [96699, 'ID'],   // Northwest Black (ID) v Sumner (WA)
]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

async function get(base, p) {
  const r = await fetch(base + p);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const fileName = p => p.replace(/[^a-z0-9_.-]+/gi, '_') + '.json';

async function capture(dir, base) {
  fs.mkdirSync(dir, { recursive: true });
  const save = (name, v) => fs.writeFileSync(path.join(dir, fileName(name)), JSON.stringify(v));
  const slugs = new Set();
  const paths = ['/api/v2/states'];
  for (const st of STATES) {
    for (const ep of ['schedule/all', 'schedule/playoffs', 'teams', 'rankings/laxnumbers', 'rankings/laxpower', 'rankings/both', 'playoff-formats']) {
      paths.push(`/api/v2/${ep}?season=${SEASON}&state=${st}`);
    }
  }
  for (const p of paths) {
    const v = await get(base, p);
    save(p, v);
    if (p.includes('/teams?') && Array.isArray(v.body?.teams)) v.body.teams.forEach(t => t.slug && slugs.add(t.slug));
    if (p.includes('/schedule/all?') && Array.isArray(v.body?.games)) v.body.games.forEach(g => { g.home?.slug && slugs.add(g.home.slug); g.away?.slug && slugs.add(g.away.slug); });
  }
  for (const s of [...slugs].sort()) save(`/api/v2/schedule/team/${s}?season=${SEASON}`, await get(base, `/api/v2/schedule/team/${s}?season=${SEASON}`));
  console.log(`   captured ${paths.length + slugs.size} responses (${paths.length} endpoints, ${slugs.size} team schedules) → ${dir}`);
}

/**
 * Pure: two captures as { fileName: parsedJson } → the verdict. The CLI reads directories
 * into this shape; the tests build it in memory.
 */
function compareCaptures(A, B, { state, expectGames = null }) {
  if (!STATES.includes(state)) throw new Error(`--state must be one of ${STATES.join(', ')}; got ${JSON.stringify(state)}`);
  const stageFile = fileName(`/api/v2/schedule/all?season=${SEASON}&state=${state}`);
  const stageGames = A[stageFile]?.body?.games;
  if (!Array.isArray(stageGames)) throw new Error(`before capture has no games in ${stageFile}`);
  const stageIds = new Set(stageGames.map(g => g.id));
  const allowed = id => stageIds.has(id) && (!CROSS_BORDER.has(id) || CROSS_BORDER.get(id) === state);

  const gained = new Map(), other = [], order = [];
  const isGame = el => el && typeof el === 'object' && !Array.isArray(el) && Number.isInteger(el.id) && 'isForfeit' in el;
  function walk(x, y, p, gameId) {
    if (Array.isArray(x) && Array.isArray(y)) {
      if ((x.length && x.every(isGame)) || (y.length && y.every(isGame))) {
        const yi = new Map(y.map(g => [g.id, g]));
        const xi = new Set(x.map(g => g.id));
        const removed = x.filter(g => !yi.has(g.id)).map(g => g.id);
        const added = y.filter(g => !xi.has(g.id)).map(g => g.id);
        if (removed.length) other.push(`${p}: game(s) removed ${removed.slice(0, 5).join(',')}`);
        if (added.length) other.push(`${p}: game(s) added ${added.slice(0, 5).join(',')}`);
        x.forEach(g => { if (yi.has(g.id)) walk(g, yi.get(g.id), `${p}[id ${g.id}]`, g.id); });
        if (!removed.length && !added.length) {
          const i = x.findIndex((g, k) => y[k].id !== g.id);
          if (i >= 0) order.push(`${p}: order differs from position ${i} (before ${x.slice(i, i + 3).map(g => g.id)} … after ${y.slice(i, i + 3).map(g => g.id)} …)`);
        }
        return;
      }
      if (x.length !== y.length) other.push(`${p}: length ${x.length} → ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${p}[${i}]`, gameId);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const kx = Object.keys(x), ky = Object.keys(y);
      if (kx.join() !== ky.join()) other.push(`${p}: keys ${kx.join()} → ${ky.join()}`);
      for (const k of kx) if (k in y && !VOLATILE.has(k)) walk(x[k], y[k], `${p}.${k}`, gameId);
      return;
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (p.endsWith('.datetime') && gameId != null && x === null && typeof y === 'string' && TIMESTAMP.test(y) && allowed(gameId)) {
      gained.set(gameId, (gained.get(gameId) || 0) + 1);
      return;
    }
    other.push(`${p}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }

  const fa = Object.keys(A).sort(), fb = Object.keys(B).sort();
  if (fa.join() !== fb.join()) other.push(`response sets differ: ${fa.length} → ${fb.length}`);
  for (const f of fa) if (f in B) walk(A[f], B[f], f.replace(/\.json$/, ''), null);

  let countOk = true;
  if (expectGames != null) countOk = expectGames === 0 ? gained.size === 0 : Math.abs(gained.size - expectGames) <= expectGames * 0.1;
  const pass = other.length === 0 && order.length === 0 && countOk;
  return { pass, gained, other, order, countOk, files: fa.length, stageGames: stageIds.size };
}

function readCapture(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) out[f] = JSON.parse(fs.readFileSync(path.join(dir, f)));
  return out;
}

function report(r, { state, expectGames }) {
  console.log(`   stage ${state}: ${r.stageGames} games in its schedule; responses compared: ${r.files}`);
  console.log(`   datetime null → value: ${r.gained.size} distinct games, ${[...r.gained.values()].reduce((s, n) => s + n, 0)} appearances` +
              (expectGames != null ? ` (expected ${expectGames}${expectGames ? ' ±10%' : ''}: ${r.countOk ? 'ok' : 'OFF'})` : ''));
  console.log(`   order differences: ${r.order.length}`);
  r.order.slice(0, 15).forEach(o => console.log(`     ORDER ${o}`));
  console.log(`   any other difference: ${r.other.length}`);
  r.other.slice(0, 15).forEach(o => console.log(`     ${o}`));
  console.log(`   ${r.pass ? 'PASS' : 'FAIL'} — ${r.pass ? `the only change is kickoff times appearing on ${state} games` : 'unexpected payload change'}`);
}

module.exports = { compareCaptures, CROSS_BORDER, fileName };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const [mode, x, y] = argv;
  if (mode === 'capture' && x && y) capture(x, y).catch(e => { console.error(e); process.exit(1); });
  else if (mode === 'compare' && x && y && opt('--state')) {
    const o = { state: opt('--state'), expectGames: opt('--expect-games') == null ? null : Number(opt('--expect-games')) };
    if (o.expectGames != null && !(Number.isInteger(o.expectGames) && o.expectGames >= 0)) { console.error('--expect-games must be a whole number'); process.exit(2); }
    const r = compareCaptures(readCapture(x), readCapture(y), o);
    report(r, o);
    if (opt('--ids-out')) fs.writeFileSync(opt('--ids-out'), [...r.gained.keys()].sort((a, b) => a - b).join('\n') + '\n');
    process.exit(r.pass ? 0 : 1);
  } else { console.error('usage: switchon-payload.js capture <dir> <apiBase> | compare <before> <after> --state <ST> [--expect-games N] [--ids-out file]'); process.exit(2); }
}
