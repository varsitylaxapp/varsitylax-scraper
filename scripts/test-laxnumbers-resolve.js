#!/usr/bin/env node
//
// test-laxnumbers-resolve.js — the game import's identity rules on fixtures. No network,
// no database. Each case is a defect this codebase has already had once.
//
//   node scripts/test-laxnumbers-resolve.js
//
// EXIT 0 all cases pass · 1 a case failed

// NO NETWORK: the import's two requests are stubbed before anything loads plan.js. A run
// fetches every feed for the opponent lookup, so an unstubbed run would reach LaxNumbers.
const FEEDS = new Map(), PAGES = new Map(), FETCHED = [];
const fetchPath = require.resolve('../src/laxnumbers-games/fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: {
  ratingsRows: async (state) => { FETCHED.push(state.code); return FEEDS.get(state.code) ?? []; },
  teamGames:   async (state, nbr) => PAGES.get(nbr) ?? [],
  politeness:  async () => {},
} };

const { buildIndexes, indexRatedByNumber } = require('../src/laxnumbers-games/resolve');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const teams = [
  { id: 1,  slug: 'mt_view',            name: 'Mountain View (OR)', state: 'OR' },
  { id: 2,  slug: 'mountain_view_wa',   name: 'Mountain View (WA)', state: 'WA' },
  { id: 3,  slug: 'mountain_view_id',   name: 'Mountain View',      state: 'ID' },
  { id: 4,  slug: 'hermiston_wa',       name: 'Hermiston',          state: 'WA' },
  { id: 5,  slug: 'liberty',            name: 'Liberty',            state: 'OR' },
  { id: 6,  slug: 'liberty_wa',         name: 'Liberty',            state: 'WA' },
  { id: 7,  slug: 'bishop_manogue_nv',  name: 'Bishop Manogue',     state: 'NV' },
  { id: 8,  slug: 'reno_placeholder',   name: 'Galena',             state: null },
  { id: 9,  slug: 'mater_dei_santa_ana',name: 'Mater Dei Santa Ana',state: 'CA' },
  { id: 10, slug: 'cody_id',            name: 'Cody',               state: 'ID' },
  { id: 11, slug: 'borah_capital_id',           name: 'Borah/Capital',            state: 'ID' },
];
const aliases = [
  { team_id: 1, state: 'OR', alias: 'Mountain View' },
  { team_id: 2, state: 'WA', alias: 'Mountain View' },
];
// Injected rulings, so the test does not depend on the live file's contents.
const ix = buildIndexes(teams, aliases, { foreignRulings: [
  { feed: 'WA', name: 'Hermiston', team: 'hermiston_wa' },
  { feed: 'ID', name: 'Cody', team: 'cody_id' },
  { feed: 'ID', name: 'Galena', team: 'somewhere_else' },
] });
const R = (name, state, code) => ix.resolveRated({ name, state }, code);
const O = (name, code) => ix.resolveOpponent(name, code);

console.log('\n1. rated teams — the both-states rule');
let r = R('Mountain View', 'ID', 'ID');
check('Idaho\'s Mountain View in ID\'s feed → mountain_view_id', r.id === 3, JSON.stringify(r));
r = R('Mountain View', 'WA', 'WA');
check('WA\'s Mountain View (alias of a renamed team) → mountain_view_wa', r.id === 2, JSON.stringify(r));
r = R('Hermiston', 'OR', 'WA');
check('Hermiston tagged OR in WA\'s feed → hermiston_wa, via the feed state, ruled', r.id === 4 && r.via === 'feed' && r.ruled, JSON.stringify(r));
r = R('Liberty', 'WA', 'OR');
check('Liberty tagged WA in OR\'s feed: two different teams → REFUSED', r.id === null && r.reason === 'ambiguous'
  && r.candidates.sort().join() === '5,6', JSON.stringify(r));
r = R('Mountain View', 'MT', 'ID');
check('a row tagged MT matching only an ID team, NOT ruled → REFUSED', r.id === null && r.reason === 'foreign-unruled'
  && r.candidates[0] === 3, JSON.stringify(r));
r = R('Cody', 'WY', 'ID');
check('a row tagged WY matching cody_id, RULED → attached', r.id === 10 && r.via === 'feed' && r.ruled === true, JSON.stringify(r));
r = R('Cody', 'WY', 'MT');
check('the same name in a feed the ruling does not cover → refused', r.id === null && r.reason === 'unknown', JSON.stringify(r));
r = R('Borah/Capital', 'MT', 'ID');
check('ruled for a DIFFERENT name only → still refused', r.id === null && r.reason === 'foreign-unruled', JSON.stringify(r));
check('a ruling naming a missing team is reported', JSON.stringify(ix.staleForeignRulings) === '["somewhere_else"]',
  JSON.stringify(ix.staleForeignRulings));
r = R('Borah/Capital', 'ID', 'ID');
check('an in-state row needs no ruling', r.id === 11 && r.via === 'row', JSON.stringify(r));
r = R('Galena', 'NV', 'NV');
check('no stateless match: a placeholder named like a rated team is NOT it', r.id === null && r.reason === 'unknown', JSON.stringify(r));
r = R('Bishop Manogue', 'NV', 'ID');
check('Bishop Manogue tagged NV in ID\'s feed → the NV team', r.id === 7 && r.via === 'row', JSON.stringify(r));
r = R('Mountain View', 'WA', 'ID');
check('Mountain View tagged WA in ID\'s feed: WA and ID teams differ → REFUSED', r.id === null && r.reason === 'ambiguous', JSON.stringify(r));

console.log('\n2. opponents — same state first, then unique-only');
let o = O('Mountain View', 'ID');
check('"Mountain View" on an Idaho page → Idaho\'s', o.id === 3 && o.via === 'state', JSON.stringify(o));
o = O('Mountain View', 'WA');
check('"Mountain View" on a WA page → WA\'s, through its alias', o.id === 2 && o.via === 'state', JSON.stringify(o));
o = O('Mountain View', 'NV');
check('"Mountain View" on a NV page: three schools → REFUSED, not last-wins', o.id === null && o.reason === 'ambiguous'
  && o.candidates.length === 3, JSON.stringify(o));
o = O('Mater Dei Santa Ana', 'NV');
check('a unique out-of-state opponent still resolves', o.id === 9 && o.via === 'unique', JSON.stringify(o));
o = O('Liberty', 'NV');
check('"Liberty" from a third state: OR and WA → REFUSED', o.id === null && o.reason === 'ambiguous', JSON.stringify(o));
o = O('Liberty', 'OR');
check('"Liberty" on an Oregon page → Oregon\'s', o.id === 5, JSON.stringify(o));
o = O('Nowhere High', 'ID');
check('unknown is unknown', o.id === null && o.reason === 'unknown', JSON.stringify(o));
o = O('Galena', 'ID');
check('a stateless placeholder still resolves as an OPPONENT when unique', o.id === 8 && o.via === 'unique', JSON.stringify(o));

console.log('\n3. ruled-out games');
const ix2 = buildIndexes(teams, aliases, { foreignRulings: [], ruledOutGames: [
  { season: 2026, date: '2026-04-10', teams: ['mountain_view_id', 'borah_capital_id'], ruling: '017708e' },
  { season: 2026, date: '2026-05-01', teams: ['borah_capital_id', 'no_such_team'], ruling: 'x' },
] });
check('matches Mountain View (ID) v Borah on 2026-04-10', ix2.ruledOut(2026, '2026-04-10', 3, 11)?.ruling === '017708e');
check('…in either home/away order', ix2.ruledOut(2026, '2026-04-10', 11, 3)?.ruling === '017708e');
check('not another date', ix2.ruledOut(2026, '2026-04-11', 3, 11) === null);
check('not another season', ix2.ruledOut(2027, '2026-04-10', 3, 11) === null);
check('not Oregon\'s Mountain View v Borah (the real game)', ix2.ruledOut(2026, '2026-04-10', 1, 11) === null);
check('a dry-run placeholder (negative id) is never ruled', ix2.ruledOut(2026, '2026-04-10', -1, 11) === null);
check('an entry naming a missing team is reported', JSON.stringify(ix2.staleRuledOut) === '["2026 2026-05-01 borah_capital_id v no_such_team"]',
  JSON.stringify(ix2.staleRuledOut));

console.log('\n4. the live rulings file');
const { loadForeignRowRulings } = require('../src/laxnumbers-games/resolve');
const live = loadForeignRowRulings();
const want = ['ID|gonzaga prep','ID|mount spokane','ID|spokane valley','ID|lewis clark','ID|bozeman black',
              'ID|northwest black','ID|jackson hole','WA|hermiston'];
check('exactly the 8 ruled rows (7 Idaho + Hermiston)', live.size === 8 && want.every(k => live.has(k)), [...live.keys()].join(', '));
const meta = require('../data/foreign-row-rulings.json');
check('approver Spencer, dated 2026-11-13, league-field note', meta.approver === 'Spencer' && meta.date === '2026-11-13' && /league field/.test(meta.note));

const ro = require('../data/ruled-out-games.json').rows;
check('live ruled-out file: exactly the Borah game, ruling 017708e', ro.length === 1 && ro[0].ruling === '017708e'
  && ro[0].date === '2026-04-10' && ro[0].teams.sort().join() === 'borah_capital_id,mountain_view_id');

console.log('\n5. a stale ruled-out entry stops the script, before any request');
const { importLaxNumbersGames } = require('../src/laxnumbers-games');
const fakeConn = { execute: async (sql) => sql.includes('FROM teams') ? [teams.filter(t => t.slug !== 'borah_capital_id')] : [aliases] };
(async () => {
  let e = null;
  try { await importLaxNumbersGames({ c: fakeConn, commit: false, season: 2026, states: [], rosterLocked: new Set() }); }
  catch (x) { e = x; }
  check('strict (the script): throws naming the entry', e && /ruled-out-games\.json: "2026 2026-04-10 mountain_view_id v borah_capital_id"/.test(e.message), e && e.message);
  e = null;
  try { await importLaxNumbersGames({ c: fakeConn, commit: false, season: 2026, states: [], rosterLocked: new Set(), strictRulings: false }); }
  catch (x) { e = x; }
  check('not strict (the cron, later): warns and carries on', e === null, e && e.message);

  console.log('\n6. opponents by TEAM NUMBER first');
  const byNbr = indexRatedByNumber(new Map([
    ['OR', [{ team_nbr: 12983, name: 'Mountain View', state: 'OR' },
            { team_nbr: 501,   name: 'Liberty',       state: 'WA' }]],
    ['ID', [{ team_nbr: 10887, name: 'Mountain View', state: 'ID' },
            { team_nbr: 999,   name: 'Mountain View', state: 'MT' },
            { team_nbr: 4242,  name: 'Cody',          state: 'WY' }]],
    ['MT', [{ team_nbr: 4242,  name: 'Cody',          state: 'WY' }]],
    ['NV', [{ team_nbr: 77,    name: 'Bishop Manogue', state: 'NV' }]],
    ['AZ', [{ team_nbr: 77,    name: 'Bishop Manogue', state: 'NV' }]],
  ]));
  const G = (opponentRaw, opponentNbr, code) => ix.resolveOpponentGame({ opponentRaw, opponentNbr }, code, byNbr);
  let g = G('Mountain View', 12983, 'ID');
  check('THE BORAH ROW: "Mountain View" t=12983 on an Idaho page → Oregon\'s mt_view, by number',
    g.id === 1 && g.by === 'number' && g.feed === 'OR', JSON.stringify(g));
  check('…where the name alone gives Idaho\'s (the old, wrong answer)', O('Mountain View', 'ID').id === 3);
  g = G('Mountain View', 10887, 'ID');
  check('t=10887 → Idaho\'s Mountain View', g.id === 3 && g.by === 'number', JSON.stringify(g));
  g = G('Mountain View', 999, 'ID');
  check('REFUSAL STANDS: a number whose row is refused (tagged MT, unruled) is unresolved',
    g.id === null && g.by === 'number' && g.reason === 'foreign-unruled' && g.nbr === 999, JSON.stringify(g));
  check('…although the name would have resolved in-state', O('Mountain View', 'ID').id === 3);
  g = G('Liberty', 501, 'OR');
  check('REFUSAL STANDS: an ambiguous rated row (Liberty tagged WA in OR\'s feed) → unresolved, no name pick',
    g.id === null && g.by === 'number' && g.reason === 'ambiguous', JSON.stringify(g));
  check('…although "Liberty" on an Oregon page names Oregon\'s by name', O('Liberty', 'OR').id === 5);
  g = G('Mountain View', null, 'ID');
  check('no link → the name rule', g.id === 3 && g.by === 'name' && g.nameWhy === 'no-link', JSON.stringify(g));
  g = G('Mater Dei Santa Ana', 31337, 'NV');
  check('a number in none of our feeds → the name rule', g.id === 9 && g.by === 'name' && g.nameWhy === 'not-in-feeds', JSON.stringify(g));
  g = G('Bishop Manogue', 77, 'ID');
  check('a number in two feeds that agree → that team', g.id === 7 && g.by === 'number', JSON.stringify(g));
  g = G('Cody', 4242, 'ID');
  check('a number in two feeds where one refuses → refused', g.id === null && g.by === 'number' && g.reason === 'unknown', JSON.stringify(g));

  console.log('\n7. through the phases: a refused number creates no placeholder; the Borah row finds OHSLA\'s game');
  FEEDS.clear(); PAGES.clear(); FETCHED.length = 0;
  FEEDS.set('ID', [{ team_nbr: 1, name: 'Borah/Capital', state: 'ID' },
                   { team_nbr: 999, name: 'Ghost', state: 'MT' }]);
  FEEDS.set('OR', [{ team_nbr: 12983, name: 'Mountain View', state: 'OR' }]);
  PAGES.set(1, [
    { date: '2026-04-10', opponentRaw: 'Mountain View', opponentNbr: 12983, isHome: false, teamScore: 13, oppScore: 12 },
    { date: '2026-04-12', opponentRaw: 'Ghost',         opponentNbr: 999,   isHome: true,  teamScore: 5,  oppScore: 4 },
    { date: '2026-04-13', opponentRaw: 'Nowhere Prep',  opponentNbr: null,  isHome: true,  teamScore: 6,  oppScore: 2 },
  ]);
  const sql = [];
  const conn = { execute: async (q, p) => { sql.push(p);
    return (p && p[2] === 1 && p[3] === 11) ? [[{ id: 243, canonical_source: 'ohsla' }]] : [[]]; } };
  const ix3 = buildIndexes(teams, aliases, { foreignRulings: [], ruledOutGames: [
    { season: 2026, date: '2026-04-10', teams: ['mountain_view_id', 'borah_capital_id'], ruling: '017708e' }] });
  const { runPhases } = require('../src/laxnumbers-games/plan');
  const ctx = { c: conn, commit: false, season: 2026, states: ['ID'], rosterLocked: new Set(), ix: ix3,
                fakeId: -1, seenThisRun: new Set(), report: { perState: {}, unresolved: new Map() } };
  const log = console.log; const out = []; console.log = (...a) => out.push(a.join(' '));
  try { await runPhases(ctx); } finally { console.log = log; }
  const st = ctx.report.perState.ID;
  check('every other feed is fetched for the lookup, Oregon included',
    ['OR', 'WA', 'AZ', 'MT', 'NV'].every(c => FETCHED.includes(c)) && FETCHED.filter(c => c === 'ID').length === 1, FETCHED.join(','));
  check('Borah 4/10 → matched OHSLA\'s game (mt_view id 1 v borah id 11); the guard does not fire',
    st.matchedExisting === 1 && st.ruledOut === 0, JSON.stringify(st));
  check('the refused number (Ghost, t=999): unresolved, NO placeholder', st.unresolved === 1 && ctx.report.unresolved.has('ID|Ghost')
    && /t=999/.test(ctx.report.unresolved.get('ID|Ghost').number), JSON.stringify([...ctx.report.unresolved.values()]));
  check('an unlinked unknown opponent still gets its placeholder (unchanged)', st.placeholders === 1 && st.wouldInsert === 1, JSON.stringify(st));
  check('counts: 2 by number, 1 by name (no link)', st.oppByNumber === 2 && st.oppByName === 1 && st.oppNoLink === 1, JSON.stringify(st));

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
process.exit(failures ? 1 : 0);
})();
