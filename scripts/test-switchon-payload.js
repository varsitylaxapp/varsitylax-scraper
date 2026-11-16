#!/usr/bin/env node
// test-switchon-payload.js — diff 9a: the switch-on payload compare, on small made-up
// captures held in memory. No database, no network, no files.
const { compareCaptures, fileName } = require('./switchon-payload');

let failures = 0;
const check = (name, ok, got) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `  — got ${got}`}`);
  if (!ok) failures++;
};
const clone = x => JSON.parse(JSON.stringify(x));
const T = '2026-04-02T01:00:00.000Z';

const game = (id, home, away, datetime = null, extra = {}) => ({
  id, season: 2026, date: '2026-04-01', dateKey: '2026-04-01', datetime, timeZone: 'America/Denver',
  status: 'final', home: { slug: home, score: 10 }, away: { slug: away, score: 4 },
  isOvertime: false, isForfeit: false, ...extra });

// MT has 1 and 2 (no time yet) and 3 (already timed). NV has 4 and the pinned 96960.
// WA has 96960 too: the cross-border game is in two state schedules.
function before() {
  const sched = st => fileName(`/api/v2/schedule/all?season=2026&state=${st}`);
  const MT = [game(1, 'a_mt', 'b_mt'), game(2, 'c_mt', 'a_mt'), game(3, 'b_mt', 'c_mt', T)];
  const NV = [game(4, 'a_nv', 'b_nv'), game(96960, 'tahoma_wa', 'coronado_nv')];
  const WA = [game(96960, 'tahoma_wa', 'coronado_nv'), game(5, 'x_wa', 'y_wa', T)];
  return {
    [sched('MT')]: { status: 200, body: { games: MT } },
    [sched('NV')]: { status: 200, body: { games: NV } },
    [sched('WA')]: { status: 200, body: { games: WA } },
    [fileName('/api/v2/schedule/team/a_mt?season=2026')]: { status: 200, body: { games: [clone(MT[0]), clone(MT[1])] } },
    [fileName('/api/v2/rankings/laxnumbers?season=2026&state=MT')]: { status: 200, body: { rankings: [{ slug: 'a_mt', rank: 1 }] } },
  };
}
const sched = st => fileName(`/api/v2/schedule/all?season=2026&state=${st}`);
const team = fileName('/api/v2/schedule/team/a_mt?season=2026');
const gameIn = (cap, file, id) => cap[file].body.games.find(g => g.id === id);
const setTime = (cap, id, t) => { for (const f in cap) for (const g of cap[f].body.games ?? []) if (g.id === id) g.datetime = t; };

function run(name, mutate, opts, expectPass, why) {
  const A = before(), B = before();
  mutate(B, A);
  const r = compareCaptures(A, B, opts);
  check(`${name} → ${expectPass ? 'PASS' : 'FAIL'}`, r.pass === expectPass, `${r.pass ? 'PASS' : 'FAIL'}; ${[...r.order, ...r.other].slice(0, 2).join(' | ')}`);
  if (why) check(`  …for the right reason: ${why.label}`, why.test(r), JSON.stringify({ other: r.other.slice(0, 2), order: r.order.slice(0, 1), gained: [...r.gained.keys()] }));
  return r;
}

console.log('\n1. what passes');
run('no change at all', () => {}, { state: 'MT' }, true);
const ok = run('MT games 1 and 2 gain a time (everywhere they appear)', B => { setTime(B, 1, T); setTime(B, 2, T); },
  { state: 'MT', expectGames: 2 }, true);
check('  counts 2 games, 4 appearances (state schedule + a_mt team schedule)', ok.gained.size === 2 && [...ok.gained.values()].reduce((s, n) => s + n) === 4);
run('the pinned cross-border game at its own stage (NV)', B => setTime(B, 96960, T), { state: 'NV' }, true);

console.log('\n2. what fails');
run('an existing time changes', B => setTime(B, 3, '2026-04-02T02:00:00.000Z'), { state: 'MT' }, false,
  { label: 'datetime value → value', test: r => r.other.some(o => /id 3\]\.datetime/.test(o)) });
run('a time goes back to null', B => setTime(B, 3, null), { state: 'MT' }, false,
  { label: 'datetime value → null', test: r => r.other.some(o => /id 3\]\.datetime: "/.test(o)) });
run('a score changes', B => { gameIn(B, sched('MT'), 1).home.score = 11; }, { state: 'MT' }, false,
  { label: 'home.score', test: r => r.other.some(o => /home\.score/.test(o)) });
run('a status changes', B => { gameIn(B, sched('MT'), 1).status = 'stale'; }, { state: 'MT' }, false,
  { label: 'status', test: r => r.other.some(o => /\.status: "final" → "stale"/.test(o)) });
run('a game is removed', B => { B[sched('MT')].body.games.pop(); }, { state: 'MT' }, false,
  { label: 'game removed', test: r => r.other.some(o => /removed 3/.test(o)) });
run('a game is added', B => { B[sched('MT')].body.games.push(game(9, 'a_mt', 'c_mt')); }, { state: 'MT' }, false,
  { label: 'game added', test: r => r.other.some(o => /added 9/.test(o)) });
run('an NV game gains a time at the MT stage', B => setTime(B, 4, T), { state: 'MT' }, false,
  { label: 'outside the stage', test: r => r.other.some(o => /id 4\]\.datetime: null/.test(o)) });
run('the cross-border game gains a time at the WA stage', B => setTime(B, 96960, T), { state: 'WA' }, false,
  { label: 'pinned to NV', test: r => r.other.some(o => /id 96960\]\.datetime: null/.test(o)) });
run('a time in the wrong format', B => setTime(B, 1, '2026-04-01 18:00:00'), { state: 'MT' }, false,
  { label: 'not a timestamp', test: r => r.other.some(o => /id 1\]\.datetime: null/.test(o)) });
run('a list reorders', B => { B[sched('MT')].body.games.reverse(); }, { state: 'MT' }, false,
  { label: 'reported as ORDER', test: r => r.order.length === 1 && r.other.length === 0 });
run('a response disappears', B => { delete B[team]; }, { state: 'MT' }, false,
  { label: 'response sets differ', test: r => r.other.some(o => /response sets differ/.test(o)) });
run('a status code changes', B => { B[team].status = 500; }, { state: 'MT' }, false,
  { label: 'status 200 → 500', test: r => r.other.some(o => /\.status: 200 → 500/.test(o)) });
run('a ranking changes', B => { B[fileName('/api/v2/rankings/laxnumbers?season=2026&state=MT')].body.rankings[0].rank = 2; }, { state: 'MT' }, false);
run('count more than 10% off --expect-games', B => setTime(B, 1, T), { state: 'MT', expectGames: 2 }, false,
  { label: 'count off, nothing else', test: r => !r.countOk && r.other.length === 0 });
run('--expect-games 0 and one game gains a time', B => setTime(B, 1, T), { state: 'MT', expectGames: 0 }, false);
check('an unknown state is refused', (() => { try { compareCaptures(before(), before(), { state: 'XX' }); return false; } catch (e) { return /--state/.test(e.message); } })());

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
process.exit(failures ? 1 : 0);
