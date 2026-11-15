#!/usr/bin/env node
//
// test-laxnumbers-write-path.js — diff 6: the write rule, game times, record/replay.
// No network, no database: LaxNumbers is stubbed and the connection is a fake.
//
//   node scripts/test-laxnumbers-write-path.js
//
// EXIT 0 all cases pass · 1 a case failed

const fs = require('fs');
const os = require('os');
const path = require('path');

// NO NETWORK: the scraper module is replaced before fetch.js loads it.
const SCRAPER = { ratings: 0, pages: 0 };
const scraperPath = require.resolve('../src/scrapers/laxnumbers');
require.cache[scraperPath] = { id: scraperPath, filename: scraperPath, loaded: true, exports: {
  fetchLaxNumbersRatingsRaw: async (state) => { SCRAPER.ratings++; return [{ team_nbr: 1, name: `${state.code} One`, state: state.code }]; },
  scrapeLaxNumbersTeamGames: async (state, nbr, season, opts) => { SCRAPER.pages++; opts.onOk('ray-' + nbr);
    return [{ date: '2026-04-01', time: '19:00', opponentRaw: 'X', opponentNbr: 2, isHome: true, teamScore: 3, oppScore: 1 }]; },
} };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const J = JSON.stringify;

const { decide, applySet } = require('../src/laxnumbers-games/apply');
const { toPacific, teamZone, loadOverrides, todayIn, isValidZone } = require('../src/laxnumbers-games/time');

(async () => {
  // ── 1. the write rule ────────────────────────────────────────────────────────
  console.log('\n1. decide(): one case per row of the write rule');
  const inc = (o = {}) => ({ homeId: 10, awayId: 20, homeScore: 8, awayScore: 6, isOvertime: false,
                             isForfeit: false, status: 'completed', dt: '2026-04-01 18:00:00', ...o });
  const row = (o = {}) => ({ id: 500, canonical_source: 'laxnumbers', home_team_id: 10, away_team_id: 20,
                             home_score: 8, away_score: 6, is_overtime: 0, is_forfeit: 0,
                             status: 'completed', dt: '2026-04-01 18:00:00', ...o });
  let d;
  d = decide(inc(), null);
  check('no row → insert (every state, Washington included)', d.action === 'insert', J(d));

  d = decide(inc(), row());
  check('ours, identical → nothing', d.action === 'none' && !Object.keys(d.set).length, J(d));
  d = decide(inc({ homeScore: 9 }), row());
  check('ours, score changed → update that field only', d.action === 'update' && J(d.set) === '{"home_score":9}', J(d.set));
  d = decide(inc({ dt: null }), row());
  check('ours, LaxNumbers time now blank → keep the stored time', d.action === 'none', J(d));
  d = decide(inc({ dt: '2026-04-01 19:00:00' }), row({ dt: null }));
  check('ours, no time yet → time set', d.action === 'update' && d.set.game_datetime === '2026-04-01 19:00:00', J(d.set));
  d = decide(inc({ homeScore: null, awayScore: null, status: 'scheduled', isOvertime: false }), row());
  check('ours, a scheduled sighting never downgrades a result', d.action === 'none', J(d));
  d = decide(inc({ homeId: 20, awayId: 10, homeScore: 6, awayScore: 8 }), row());
  check('ours, LaxNumbers has home/away the other way → not flipped, scores mapped, no false update',
    d.flipped && d.action === 'none', J(d));
  d = decide(inc({ isOvertime: true }), row());
  check('ours, even on a fill-only game → we update our own row', d.action === 'update' && d.set.is_overtime === 1, J(d.set));

  const wh = (o = {}) => row({ canonical_source: 'whsbla', ...o });
  d = decide(inc(), wh({ home_score: null, away_score: null, status: 'scheduled' }));
  check('WHSBLA, no scores → fill both, scheduled → completed',
    d.action === 'fill' && J(d.set) === '{"home_score":8,"away_score":6,"status":"completed"}' && !d.conflicts.length, J(d));
  d = decide(inc(), wh({ home_score: null, away_score: null, status: 'stale' }));
  check('WHSBLA, stale fixture → filled and completed', d.set.status === 'completed', J(d.set));
  d = decide(inc(), wh({ dt: null }));
  check('WHSBLA, no time → fill the time only', d.action === 'fill' && J(d.set) === '{"game_datetime":"2026-04-01 18:00:00"}', J(d.set));
  d = decide(inc({ homeScore: 9 }), wh());
  check('WHSBLA, scores disagree → conflict logged, nothing set',
    d.action === 'none' && d.conflicts.length === 1 && d.conflicts[0].field === 'home_score'
      && d.conflicts[0].owner === 'whsbla' && d.conflicts[0].owner_value === '8' && d.conflicts[0].other_value === '9', J(d));
  d = decide(inc({ isOvertime: true }), wh());
  check('WHSBLA, OT 0 vs LaxNumbers OT → conflict, NEVER filled (0 is not empty)',
    !('is_overtime' in d.set) && d.conflicts.some(x => x.field === 'is_overtime' && x.owner_value === '0' && x.other_value === '1'), J(d));
  d = decide(inc({ isForfeit: true }), wh());
  check('WHSBLA, forfeit disagrees → conflict, never filled', !('is_forfeit' in d.set) && d.conflicts.some(x => x.field === 'is_forfeit'), J(d));
  d = decide(inc({ dt: '2026-04-01 19:00:00' }), wh());
  check('WHSBLA, times disagree → conflict in the import-whsbla.js format',
    d.conflicts.length === 1 && d.conflicts[0].owner_value === '2026-04-01T18:00:00' && d.conflicts[0].other_value === '2026-04-01T19:00:00', J(d));
  d = decide(inc({ homeId: 20, awayId: 10, homeScore: 6, awayScore: 8 }), wh());
  check('WHSBLA, home/away the other way → orientation conflict only; scores mapped, so no false score conflict',
    d.conflicts.length === 1 && d.conflicts[0].field === 'home_away_orientation' && d.action === 'none', J(d));
  d = decide(inc({ homeScore: null, awayScore: null, status: 'scheduled' }), wh({ is_overtime: 1 }));
  check('WHSBLA, LaxNumbers has no result → no OT/forfeit/score comparison at all', !d.conflicts.length && d.action === 'none', J(d));
  d = decide(inc(), wh({ canonical_source: 'ohsla' }));
  check('any other owner gets the same treatment (OHSLA)', d.action === 'none', J(d));
  d = decide(inc(), row({ canonical_source: null, home_score: null, away_score: null, status: 'scheduled' }));
  check('an unowned row is filled, never taken over', d.action === 'fill' && d.conflicts.every(x => x.owner === '(none)'), J(d));

  // ── 2. applySet ──────────────────────────────────────────────────────────────
  console.log('\n2. applySet: a fill can never overwrite');
  const seen = [];
  const c1 = { execute: async (q, p) => { seen.push(q.replace(/\s+/g, ' ')); return [{ affectedRows: 1 }]; } };
  await applySet(c1, 7, { home_score: 1, away_score: 2, status: 'completed' }, true);
  check('fill: each value column guarded IS NULL in the statement',
    /AND home_score IS NULL AND away_score IS NULL$/.test(seen[0].trim()) && !/status IS NULL/.test(seen[0]), seen[0]);
  await applySet(c1, 7, { home_score: 1 }, false);
  check('update: no guard', !/IS NULL/.test(seen[1]), seen[1]);
  let e = null; try { await applySet(c1, 7, { canonical_source: 'x' }, false); } catch (x) { e = x; }
  check('refuses any column outside the write rule', e && /refusing column canonical_source/.test(e.message));
  e = null; try { await applySet({ execute: async () => [{ affectedRows: 0 }] }, 7, { home_score: 1 }, true); } catch (x) { e = x; }
  check('a fill that matches no row (the field was filled meanwhile) throws, so the state rolls back', e && /matched 0 rows/.test(e.message));

  // ── 3. times ─────────────────────────────────────────────────────────────────
  console.log('\n3. times: home team\'s zone → Pacific wall-clock, by IANA rules');
  const T = (date, time, zone) => toPacific(date, time, zone).value;
  check('Arizona 19:30 on Mar 5 (Pacific still on standard time) → 18:30 Pacific', T('2026-03-05', '19:30', 'America/Phoenix') === '2026-03-05 18:30:00');
  check('Arizona 19:30 on Mar 9 (Pacific on daylight time from Mar 8) → 19:30', T('2026-03-09', '19:30', 'America/Phoenix') === '2026-03-09 19:30:00');
  check('Arizona 19:30 in May → 19:30', T('2026-05-01', '19:30', 'America/Phoenix') === '2026-05-01 19:30:00');
  check('Boise 19:30 in March and in May → 18:30 both', T('2026-03-05', '19:30', 'America/Boise') === '2026-03-05 18:30:00' && T('2026-05-01', '19:30', 'America/Boise') === '2026-05-01 18:30:00');
  check('Nevada 19:00 → 19:00', T('2026-04-10', '19:00', 'America/Los_Angeles') === '2026-04-10 19:00:00');
  check('2027: the DST date moves (Mar 14) and the rule follows without a code change',
    T('2027-03-12', '19:00', 'America/Phoenix') === '2027-03-12 18:00:00' && T('2027-03-15', '19:00', 'America/Phoenix') === '2027-03-15 19:00:00');
  check('spring-forward gap → not stored', toPacific('2026-03-08', '02:30', 'America/Los_Angeles').why === 'nonexistent');
  check('blank, unreadable, no zone → not stored, with the reason',
    toPacific('2026-04-01', '', 'America/Boise').why === 'no-time' && toPacific('2026-04-01', '7pm', 'America/Boise').why === 'unreadable'
      && toPacific('2026-04-01', '19:00', null).why === 'no-zone');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'laxnumbers-games', 'time.js'), 'utf8');
  check('time.js hard-codes no offset or DST date', !/GMT[+-]|[+-]0[5-8]:00|-0[78]00|Mar(ch)? \d|11-0[1-7]|03-(0[89]|1[0-4])/.test(src.replace(/^\s*\/\/.*$|^\s*\*.*$/gm, '')));
  const ov = loadOverrides();
  check('team-timezones.json loads; every zone is a real IANA zone', ov.size >= 1 && [...ov.values()].every(isValidZone), `${ov.size} teams`);
  check('a panhandle team uses its override (Coeur d\'Alene → Pacific)', teamZone({ slug: 'coeur_d_alene_id', state: 'ID' }, ov) === 'America/Los_Angeles');
  check('any other Idaho team → the registry (America/Boise)', teamZone({ slug: 'borah_capital_id', state: 'ID' }, ov) === 'America/Boise');
  check('Arizona → America/Phoenix; California (not in the registry) → Los Angeles; unknown → null',
    teamZone({ slug: 'x', state: 'AZ' }, ov) === 'America/Phoenix' && teamZone({ slug: 'x', state: 'CA' }, ov) === 'America/Los_Angeles'
      && teamZone({ slug: 'x', state: 'ZZ' }, ov) === null && teamZone({ slug: 'x', state: null }, ov) === null);
  check('today in a zone', todayIn('America/Phoenix', Date.UTC(2026, 3, 2, 5, 0)) === '2026-04-01' && todayIn('America/Denver', Date.UTC(2026, 3, 2, 7, 0)) === '2026-04-02');

  // ── 4. through the phases ───────────────────────────────────────────────────
  console.log('\n4. through the phases (fake connection): Oregon, fixtures, the home team\'s zone, fill-only');
  const fetchPath = require.resolve('../src/laxnumbers-games/fetch');
  const realFetch = require.cache[fetchPath];
  const FEEDS = new Map(), PAGES = new Map();
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: {
    ratingsRows: async (state) => FEEDS.get(state.code) ?? [],
    teamGames: async (state, nbr) => PAGES.get(nbr) ?? [],
    politeness: async () => {},
  } };
  const planPath = require.resolve('../src/laxnumbers-games/plan');
  delete require.cache[planPath];
  const { runPhases } = require('../src/laxnumbers-games/plan');
  const { buildIndexes } = require('../src/laxnumbers-games/resolve');
  const teams = [
    { id: 1, slug: 'phx_one_az', name: 'Phoenix One', state: 'AZ' },
    { id: 2, slug: 'boise_two_id', name: 'Boise Two', state: 'ID' },
    { id: 3, slug: 'oregon_three', name: 'Oregon Three', state: 'OR' },
    { id: 4, slug: 'wa_four_wa', name: 'Wa Four', state: 'WA' },
    { id: 5, slug: 'wa_five_wa', name: 'Wa Five', state: 'WA' },
  ];
  FEEDS.set('AZ', [{ team_nbr: 101, name: 'Phoenix One', state: 'AZ' }]);
  FEEDS.set('ID', [{ team_nbr: 102, name: 'Boise Two', state: 'ID' }]);
  FEEDS.set('OR', [{ team_nbr: 103, name: 'Oregon Three', state: 'OR' }]);
  FEEDS.set('WA', [{ team_nbr: 104, name: 'Wa Four', state: 'WA' }, { team_nbr: 105, name: 'Wa Five', state: 'WA' }]);
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  PAGES.set(101, [
    // At Boise in May: the HOME team is Idaho's, so 19:30 is Boise time (18:30 Pacific).
    // Read in the page team's zone (Phoenix) it would be 19:30 — May is where they differ.
    { date: '2026-05-05', time: '19:30', opponentRaw: 'Boise Two', opponentNbr: 102, isHome: false, teamScore: 4, oppScore: 5 },
    { date: '2026-03-20', time: '18:00', opponentRaw: 'Oregon Three', opponentNbr: 103, isHome: true, teamScore: 9, oppScore: 2 },
    { date: '2026-03-21', time: '18:00', opponentRaw: 'Boise Two', opponentNbr: 102, isHome: true, teamScore: null, oppScore: null },
    { date: future,       time: '19:00', opponentRaw: 'Boise Two', opponentNbr: 102, isHome: true, teamScore: null, oppScore: null },
  ]);
  PAGES.set(104, [{ date: '2026-04-02', time: '17:00', opponentRaw: 'Wa Five', opponentNbr: 105, isHome: true, teamScore: 7, oppScore: 7 }]);
  const writes = [];
  const conn = {
    execute: async (q, p) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(q)) writes.push([q.trim().split(/\s+/).slice(0, 3).join(' '), p]);
      if (/INSERT INTO games/.test(q)) return [{ insertId: 900 + writes.length, affectedRows: 1 }];
      return [[]]; },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
  };
  const ctx = { c: conn, commit: true, season: 2026, states: ['AZ', 'WA'], rosterLocked: new Set(['OR', 'WA']),
                ix: buildIndexes(teams, [], { foreignRulings: [], ruledOutGames: [] }), strictRulings: true,
                fakeId: -1, seenThisRun: new Set(), report: { perState: {}, unresolved: new Map() },
                http: { mode: 'live', dir: null, spacingMs: 0 }, counter: { requests: 0 }, zoneOverrides: new Map() };
  const log = console.log; const out = []; console.log = (...a) => out.push(a.join(' '));
  try { await runPhases(ctx); } finally { console.log = log; }
  const az = ctx.report.perState.AZ, wa = ctx.report.perState.WA;
  const gi = writes.filter(w => w[0] === 'INSERT INTO games');
  check('Oregon side → counted, nothing written for it', az.oregon === 1 && !gi.some(w => w[1].includes(3)), J(az));
  check('past "-" → no result, skipped', az.noResult === 1, J(az));
  check('future "-" → inserted as scheduled, no scores', az.scheduled === 1 && gi.some(w => w[1][0] === 2026 && w[1][1] === future && w[1][7] === 'scheduled' && w[1][5] === null), J(gi));
  const boise = gi.find(w => w[1][1] === '2026-05-05');
  check('away game at Boise: 19:30 read in the HOME team\'s zone (Boise) → 18:30 Pacific', boise && boise[1][2] === '2026-05-05 18:30:00', J(boise));
  check('every inserted game gets its source row', writes.filter(w => w[0] === 'INSERT INTO game_source_records').length === gi.length, `${gi.length} games`);
  check('Washington-only game with no league row → inserted as laxnumbers (WHSBLA takes it over later)',
    wa.inserted === 1 && gi.some(w => w[1][1] === '2026-04-02' && w[1].includes(4) && w[1].includes(5)), J(wa));
  require.cache[fetchPath] = realFetch;

  // ── 5. record and replay ────────────────────────────────────────────────────
  console.log('\n5. record, then replay with zero requests');
  delete require.cache[fetchPath];
  const F = require('../src/laxnumbers-games/fetch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lnrec-'));
  const st = { code: 'AZ' };
  const cnt = { requests: 0 }, pages = { ok: 0 };
  await F.ratingsRows(st, 2026, { mode: 'record', dir, spacingMs: 0 }, cnt);
  await F.teamGames(st, 101, 2026, pages, { mode: 'record', dir, spacingMs: 0 }, cnt);
  check('record: two requests, two files', cnt.requests === 2 && fs.readdirSync(dir).length === 2, fs.readdirSync(dir).join(','));
  const before = { ...SCRAPER }, cnt2 = { requests: 0 }, pages2 = { ok: 0 };
  const rr = await F.ratingsRows(st, 2026, { mode: 'replay', dir }, cnt2);
  const rg = await F.teamGames(st, 101, 2026, pages2, { mode: 'replay', dir }, cnt2);
  check('replay: same data back, zero requests', rr[0].name === 'AZ One' && rg[0].time === '19:00' && cnt2.requests === 0
    && SCRAPER.ratings === before.ratings && SCRAPER.pages === before.pages, J({ cnt2, SCRAPER }));
  e = null; try { await F.teamGames(st, 999, 2026, pages2, { mode: 'replay', dir }, cnt2); } catch (x) { e = x; }
  check('replay: a missing response is an error, never a live request', e && /no recorded response team-999-2026/.test(e.message) && SCRAPER.pages === before.pages);
  const t0 = Date.now(); await F.politeness({ mode: 'record', spacingMs: 150 }); const dt = Date.now() - t0;
  check('spacing is honoured when requesting, skipped when replaying', dt >= 140 && (await (async () => { const t = Date.now(); await F.politeness({ mode: 'replay' }); return Date.now() - t < 20; })()), `${dt} ms`);
  // Deletes only inside its own mkdtemp folder, and refuses anywhere else (guard rule).
  const tmp = fs.realpathSync(os.tmpdir()), real = fs.realpathSync(dir);
  if (!real.startsWith(tmp + path.sep) || !path.basename(real).startsWith('lnrec-')) throw new Error(`refusing to delete outside scratch: ${real}`);
  for (const f of fs.readdirSync(real)) fs.unlinkSync(path.join(real, f));
  fs.rmdirSync(real);

  console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
  process.exit(failures ? 1 : 0);
})();
