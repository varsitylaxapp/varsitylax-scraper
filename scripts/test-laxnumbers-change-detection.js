#!/usr/bin/env node
//
// test-laxnumbers-change-detection.js — diff 7: which team pages a run reads, the request
// cap, the first-403 stop, and the remembered team number → team identity
// (src/laxnumbers-games/teams.js, migrations/section-n-laxnumbers-teams.sql).
// No network, no database: fetch.js and the connection are stubbed.
//
//   node scripts/test-laxnumbers-change-detection.js
//
// EXIT 0 all cases pass · 1 a case failed

const FEEDS = new Map(), PAGES = new Map(), CALLS = [];
let THROW_AT = null;     // the Nth team-page call throws a 403, as LaxNumbers' challenge does
const fetchPath = require.resolve('../src/laxnumbers-games/fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: {
  ratingsRows: async (state) => FEEDS.get(state.code) ?? [],
  teamGames: async (state, nbr) => {
    CALLS.push(nbr);
    if (THROW_AT && CALLS.length === THROW_AT) throw new Error(`LaxNumbers 403 for https://laxnumbers.com/team_info.php?y=2026&t=${nbr}`);
    return PAGES.get(nbr) ?? [];
  },
  politeness: async () => {},
} };

const { whyFetch, identity, pacificMidnightUtc, key } = require('../src/laxnumbers-games/teams');
const { buildIndexes } = require('../src/laxnumbers-games/resolve');
const { runPhases } = require('../src/laxnumbers-games/plan');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const J = JSON.stringify;

(async () => {
  console.log('\n1. whyFetch');
  const cut = '2026-11-15 08:00:00';
  const opt = { changedOnly: true, cutoffUtc: cut };
  const fresh = { teamId: 1, gp: 10, fetchedAt: '2026-11-15 09:00:00' };
  check('full pass → all, stored or not', whyFetch({ gp: 10 }, fresh, { changedOnly: false, cutoffUtc: cut }) === 'all');
  check('nothing stored → new', whyFetch({ gp: 10 }, undefined, opt) === 'new');
  check('gp moved → gp', whyFetch({ gp: 11 }, fresh, opt) === 'gp');
  check('gp missing from the feed → gp (read it, never assume unchanged)', whyFetch({ gp: null }, fresh, opt) === 'gp');
  check('gp as a string compares as a number', whyFetch({ gp: '10' }, fresh, opt) === null);
  check('read before today\'s Pacific midnight → daily', whyFetch({ gp: 10 }, { ...fresh, fetchedAt: '2026-11-15 07:59:59' }, opt) === 'daily');
  check('same gp, read today → skip', whyFetch({ gp: 10 }, fresh, opt) === null);

  console.log('\n2. identity');
  const ex = id => id !== 99;
  check('nothing stored → the fresh result', identity({ id: 5 }, undefined, ex).id === 5);
  check('agree → the fresh result', identity({ id: 5, via: 'row' }, { teamId: 5 }, ex).via === 'row');
  const conf = identity({ id: 5 }, { teamId: 6 }, ex);
  check('disagree → refused as identity-conflict, both ids kept', conf.id === null && conf.reason === 'identity-conflict'
    && conf.storedId === 6 && conf.freshId === 5, J(conf));
  const ren = identity({ id: null, reason: 'unknown' }, { teamId: 6 }, ex);
  check('fresh finds nothing (a rename) → the stored team', ren.id === 6 && ren.via === 'stored', J(ren));
  check('fresh REFUSES (ambiguous) → the refusal stands', identity({ id: null, reason: 'ambiguous', candidates: [1, 2] }, { teamId: 6 }, ex).reason === 'ambiguous');
  check('fresh REFUSES (foreign-unruled) → the refusal stands', identity({ id: null, reason: 'foreign-unruled' }, { teamId: 6 }, ex).reason === 'foreign-unruled');
  check('stored team no longer exists → the fresh result', identity({ id: null, reason: 'unknown' }, { teamId: 99 }, ex).reason === 'unknown');

  console.log('\n3. the daily cutoff: today\'s Pacific midnight, in UTC');
  check('November (PST) → 08:00 UTC', pacificMidnightUtc(Date.parse('2026-11-15T21:00:00Z')) === '2026-11-15 08:00:00',
    pacificMidnightUtc(Date.parse('2026-11-15T21:00:00Z')));
  check('June 30 11:30pm Pacific (PDT) → June 30, 07:00 UTC', pacificMidnightUtc(Date.parse('2026-07-01T06:30:00Z')) === '2026-06-30 07:00:00',
    pacificMidnightUtc(Date.parse('2026-07-01T06:30:00Z')));

  // ── a four-team Idaho feed through the real phases ──────────────────────────────────
  const teams = [
    { id: 1, slug: 'boise_id', name: 'Boise', state: 'ID' },
    { id: 2, slug: 'eagle_id', name: 'Eagle', state: 'ID' },
    { id: 3, slug: 'kuna_id', name: 'Kuna', state: 'ID' },
    { id: 4, slug: 'meridian_id', name: 'Meridian', state: 'ID' },
  ];
  const feed = (boise = 'Boise') => [
    { team_nbr: 101, name: boise, state: 'ID', gp: 1 }, { team_nbr: 102, name: 'Eagle', state: 'ID', gp: 1 },
    { team_nbr: 103, name: 'Kuna', state: 'ID', gp: 1 }, { team_nbr: 104, name: 'Meridian', state: 'ID', gp: 1 }];
  const page = (opp, nbr, home, a, b, date = '2026-04-01') => ({ date, opponentRaw: opp, opponentNbr: nbr, isHome: home, teamScore: a, oppScore: b, time: '' });
  const setPages = (extraKuna = []) => {
    PAGES.clear();
    PAGES.set(101, [page('Eagle', 102, true, 5, 4)]);
    PAGES.set(102, [page('Boise', 101, false, 4, 5)]);
    PAGES.set(103, [page('Meridian', 104, true, 7, 6), ...extraKuna]);
    PAGES.set(104, [page('Kuna', 103, false, 6, 7)]);
  };
  const today = '2026-11-15 20:00:00';
  const allStored = (over = {}) => new Map([101, 102, 103, 104].map((n, i) =>
    [key('ID', n), { teamId: i + 1, gp: 1, fetchedAt: today, ...(over[n] ?? {}) }]));

  async function run({ stored = null, changedOnly = false, maxRequests = 160, commit = false, boise } = {}) {
    FEEDS.clear(); FEEDS.set('ID', feed(boise)); CALLS.length = 0;
    const events = []; let nextId = 1000;
    const c = {
      execute: async (sql, p) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        events.push({ s, p });
        if (/^INSERT INTO games\b/.test(s)) return [{ insertId: nextId++ }];
        if (/^SELECT/.test(s)) return [[]];
        return [{ affectedRows: 1 }];
      },
      beginTransaction: async () => events.push({ s: 'BEGIN' }),
      commit: async () => events.push({ s: 'COMMIT' }),
      rollback: async () => events.push({ s: 'ROLLBACK' }),
    };
    const ctx = { c, commit, season: 2026, states: ['ID'], rosterLocked: new Set(['ID']), strictRulings: true,
                  ix: buildIndexes(teams, [], { foreignRulings: [], ruledOutGames: [] }),
                  fakeId: -1, seenThisRun: new Set(), report: { perState: {}, unresolved: new Map() },
                  http: { mode: 'live', dir: null, spacingMs: 0 }, counter: { requests: 0, reads: 0 },
                  zoneOverrides: new Map(), stored, changedOnly, maxRequests, cutoffUtc: cut };
    const log = console.log; const out = []; console.log = (...a) => out.push(a.join(' '));
    let error = null;
    try { await runPhases(ctx); } catch (e) { error = e; } finally { console.log = log; }
    const lnt = events.filter(e => /^INSERT INTO laxnumbers_teams/.test(e.s));
    const games = events.filter(e => /^INSERT INTO games\b/.test(e.s));
    return { ctx, events, out, error, lnt, games, st: ctx.report.perState.ID };
  }
  const RATINGS = 6;   // ID, plus every other feed for the opponent lookup (OR WA AZ MT NV)

  console.log('\n4. which pages a run reads');
  setPages();
  let r = await run();
  check(`full pass: ${RATINGS} ratings + 4 pages = 10 reads`, r.ctx.counter.reads === 10 && CALLS.length === 4, `${r.ctx.counter.reads} ${CALLS}`);
  r = await run({ stored: allStored(), changedOnly: true });
  check(`changed-only, nothing moved: ${RATINGS} + 0`, r.ctx.counter.reads === RATINGS && CALLS.length === 0 && r.st.skipped === 4, `${r.ctx.counter.reads} ${CALLS}`);
  const s3 = allStored({ 101: { gp: 0 }, 103: { fetchedAt: '2026-11-14 23:00:00' } }); s3.delete(key('ID', 104));
  r = await run({ stored: s3, changedOnly: true });
  check('one gp moved, one read yesterday, one never stored → exactly those 3 pages',
    J(CALLS.slice().sort()) === J([101, 103, 104]) && r.ctx.counter.reads === RATINGS + 3, `${CALLS}`);
  check('the state line says why', r.out.some(l => /read 3: new 1, gp 1, daily 1; unchanged, skipped 1; over the cap 0/.test(l)),
    r.out.find(l => l.startsWith('[LaxNumbers:ID]')));
  check('changed-only, dry run: nothing remembered', r.lnt.length === 0);

  console.log('\n5. the request cap');
  r = await run({ maxRequests: RATINGS + 1 });
  check(`cap ${RATINGS + 1}: 1 page read, 3 over the cap`, CALLS.length === 1 && r.st.capped === 3 && r.ctx.counter.reads === RATINGS + 1, `${CALLS} ${J(r.st && { capped: r.st.capped })}`);
  r = await run({ maxRequests: RATINGS + 1, commit: true, stored: new Map() });
  check('a capped page is not remembered, so the next run still sees it due', r.lnt.length === 1 && r.lnt[0].p[2] === 101, J(r.lnt.map(e => e.p)));

  console.log('\n6. the first 403 stops the job');
  THROW_AT = 2;
  r = await run({ commit: true, stored: new Map() });
  THROW_AT = null;
  check('the run throws the 403', /LaxNumbers 403/.test(r.error?.message ?? ''), r.error?.message);
  check('no page is requested after it', CALLS.length === 2, `${CALLS}`);
  check('nothing written for any state: no game, nothing remembered', r.games.length === 0 && r.lnt.length === 0,
    `games ${r.games.length}, remembered ${r.lnt.length}`);

  console.log('\n7. remembered in the same transaction as the games, clean pages only');
  setPages([page('Nowhere Prep', null, true, 9, 1, '2026-04-02')]);     // Kuna's page has an unresolvable row
  r = await run({ commit: true, stored: new Map() });
  const idx = re => r.events.findIndex(e => re.test(e.s));
  const lastIdx = re => r.events.map(e => re.test(e.s)).lastIndexOf(true);
  const begins = r.events.map((e, i) => e.s === 'BEGIN' ? i : -1).filter(i => i >= 0);
  const commits = r.events.map((e, i) => e.s === 'COMMIT' ? i : -1).filter(i => i >= 0);
  check('2 games inserted (Boise–Eagle, Kuna–Meridian), each once', r.games.length === 2, r.games.length);
  check('remembered: Boise, Eagle, Meridian — not Kuna (its page has an unresolved row)',
    J(r.lnt.map(e => e.p[2]).sort()) === J([101, 102, 104]), J(r.lnt.map(e => e.p)));
  check('stored with the team id and gp', r.lnt.every(e => e.p[0] === 2026 && e.p[1] === 'ID' && e.p[3] === e.p[2] - 100 && e.p[4] === 1), J(r.lnt.map(e => e.p)));
  check('inside the state\'s game transaction: after its BEGIN, before its COMMIT',
    begins.length === 2 && commits.length === 2 && idx(/^INSERT INTO laxnumbers_teams/) > begins[1]
      && lastIdx(/^INSERT INTO laxnumbers_teams/) < commits[1], `begins ${begins} commits ${commits}`);
  r = await run({ commit: true, stored: null });
  check('no table (a database before section N): runs as before, remembers nothing', r.games.length === 2 && r.lnt.length === 0);

  console.log('\n8. identity: a disagreement is refused, a rename is followed');
  setPages();
  r = await run({ commit: true, stored: allStored({ 101: { teamId: 2 } }) });
  check('t=101 stored as Eagle, looked up as Boise → IDENTITY CONFLICT logged', r.st.identityConflicts === 1
    && r.out.some(l => /IDENTITY CONFLICT: t=101 "Boise" is stored as ID:eagle_id, the lookup now says ID:boise_id/.test(l)));
  check('and the opponent link to t=101 on Eagle\'s page is refused too: the game is not imported',
    r.games.length === 1 && r.ctx.report.unresolved.has('ID|Boise'), `games ${r.games.length} ${J([...r.ctx.report.unresolved.keys()])}`);
  check('neither page is remembered; Kuna and Meridian are', J(r.lnt.map(e => e.p[2]).sort()) === J([103, 104]), J(r.lnt.map(e => e.p[2])));
  check('the unresolved list carries the reason', /stored as ID:eagle_id/.test(r.ctx.report.unresolved.get('ID|Boise')?.identity ?? ''));
  r = await run({ commit: true, stored: allStored(), boise: 'Boise Brave' });
  check('renamed upstream ("Boise Brave"): found by its stored number', r.st.byStored === 1 && r.st.unresolved === 0 && r.games.length === 2,
    J({ byStored: r.st.byStored, unresolved: r.st.unresolved, games: r.games.length }));
  r = await run({ commit: true, stored: null, boise: 'Boise Brave' });
  check('the same rename with nothing stored: unresolved, as before diff 7', r.st.unresolved >= 1 && r.games.length === 1,
    J({ unresolved: r.st.unresolved, games: r.games.length }));

  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
})();
