#!/usr/bin/env node
/**
 * Window #6's expected API diff, captured and asserted.
 *
 *   node scripts/window6-payload.js capture <dir> <apiBase>
 *   node scripts/window6-payload.js compare <beforeDir> <afterDir>
 *
 * CAPTURE saves every v2 read endpoint for the six states (status and body), and the
 * schedule of every team those endpoints name.
 *
 * COMPARE passes only when the one difference anywhere is `isForfeit` going false → true
 * on a game whose id is one of the 10 WHSBLA forfeits, and every one of the 10 shows that
 * flip somewhere. Games are matched by id (the same database before and after, so ids are
 * stable); anything else is compared positionally, and key order counts.
 */
const fs = require('fs');
const path = require('path');

const FORFEIT_IDS = new Set([76032, 76159, 76200, 76274, 76293, 76314, 76324, 76355, 76356, 76376]);
const STATES = ['OR', 'WA', 'AZ', 'ID', 'MT', 'NV'];
const SEASON = 2026;
const VOLATILE = new Set(['updated', 'lastScrape', 'lastGameWrite', 'lastSnapshot', 'scrapedAt', 'scraped_at']);

async function get(base, p) {
  const r = await fetch(base + p);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function capture(dir, base) {
  fs.mkdirSync(dir, { recursive: true });
  const save = (name, v) => fs.writeFileSync(path.join(dir, name.replace(/[^a-z0-9_.-]+/gi, '_') + '.json'), JSON.stringify(v));
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

function compare(a, b) {
  const flips = new Map(), other = [];
  // A game in any v2 shape: /schedule/all has home/away objects, /schedule/team/:slug has
  // the team's view of it. Both carry the game's id and isForfeit.
  const isGame = el => el && typeof el === 'object' && !Array.isArray(el) && Number.isInteger(el.id) && 'isForfeit' in el;
  function walk(x, y, p, gameId) {
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length && x.every(isGame) && y.every(isGame)) {
        const yi = new Map(y.map(g => [g.id, g]));
        if (x.length !== y.length || x.some(g => !yi.has(g.id))) other.push(`${p}: game set differs`);
        x.forEach((g, i) => { if (yi.has(g.id)) walk(g, yi.get(g.id), `${p}[id ${g.id}]`, g.id); if (y[i]?.id !== g.id) other.push(`${p}: order differs at ${i}`); });
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
    if (p.endsWith('.isForfeit') && x === false && y === true && FORFEIT_IDS.has(gameId)) {
      flips.set(gameId, (flips.get(gameId) || 0) + 1);
      return;
    }
    other.push(`${p}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }
  const files = fs.readdirSync(a).filter(f => f.endsWith('.json')).sort();
  const filesB = fs.readdirSync(b).filter(f => f.endsWith('.json')).sort();
  if (files.join() !== filesB.join()) other.push(`file sets differ: ${files.length} → ${filesB.length}`);
  for (const f of files) {
    if (!fs.existsSync(path.join(b, f))) continue;
    walk(JSON.parse(fs.readFileSync(path.join(a, f))), JSON.parse(fs.readFileSync(path.join(b, f))), f.replace(/\.json$/, ''), null);
  }
  const missing = [...FORFEIT_IDS].filter(id => !flips.has(id));
  console.log(`   files compared: ${files.length}`);
  console.log(`   isForfeit false → true: ${flips.size} distinct games, ${[...flips.values()].reduce((s, n) => s + n, 0)} appearances`);
  console.log(`   the 10 pinned forfeits all flipped: ${missing.length ? 'NO, missing ' + missing.join(',') : 'yes'}`);
  console.log(`   any other difference: ${other.length}`);
  other.slice(0, 15).forEach(o => console.log(`     ${o}`));
  const pass = missing.length === 0 && other.length === 0 && flips.size === FORFEIT_IDS.size;
  console.log(`   ${pass ? 'PASS' : 'FAIL'} — ${pass ? 'the only change is FF on the 10 WHSBLA forfeits' : 'unexpected payload change'}`);
  return pass;
}

const [mode, x, y] = process.argv.slice(2);
if (mode === 'capture' && x && y) capture(x, y).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'compare' && x && y) process.exit(compare(x, y) ? 0 : 1);
else { console.error('usage: window6-payload.js capture <dir> <apiBase> | compare <before> <after>'); process.exit(2); }
