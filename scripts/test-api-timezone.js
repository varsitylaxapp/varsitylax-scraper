#!/usr/bin/env node
// The per-game `timeZone` field: the home team's IANA zone, additive and last.
// No database: src/db is stubbed before api-v2 loads.
//   node scripts/test-api-timezone.js
const fs = require('fs'), os = require('os'), path = require('path');
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const J = JSON.stringify;

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { execute: async () => [[]] } };

const { teamZone, loadOverrides, isValidZone, STATE_ZONES } = require('../src/time-zones');
const { gameJson } = require('../src/api-v2');

console.log('\n1. the override file');
const ov = loadOverrides();
check('loads, 12 teams', ov.size === 12, ov.size);
check('every zone is a real IANA zone', [...ov.values()].every(isValidZone));
check('every STATE_ZONES entry is a real IANA zone', Object.values(STATE_ZONES).every(isValidZone));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-'));
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, J({ teams: [{ slug: 'x_id', zone: 'Mountain' }] }));
let threw = null; try { loadOverrides(bad); } catch (e) { threw = e.message; }
check('an unknown zone is refused', /unknown zone "Mountain"/.test(threw ?? ''), threw);
fs.writeFileSync(bad, J({ teams: [{ slug: 'x_id', zone: 'America/Boise' }, { slug: 'x_id', zone: 'America/Denver' }] }));
threw = null; try { loadOverrides(bad); } catch (e) { threw = e.message; }
check('a slug listed twice is refused', /listed twice/.test(threw ?? ''), threw);
fs.rmSync(tmp, { recursive: true });

console.log('\n2. teamZone');
const z = (slug, state) => teamZone({ slug, state }, ov);
for (const [slug, state, want] of [
  ['oes', 'OR', 'America/Los_Angeles'],
  ['mount_si_wa', 'WA', 'America/Los_Angeles'],
  ['boise_id', 'ID', 'America/Boise'],
  ['coeur_d_alene_id', 'ID', 'America/Los_Angeles'],     // panhandle override
  ['gonzaga_prep_id', 'ID', 'America/Los_Angeles'],      // Spokane, rostered in Idaho
  ['bozeman_black_id', 'ID', 'America/Denver'],
  ['any_az', 'AZ', 'America/Phoenix'],
  ['any_mt', 'MT', 'America/Denver'],
  ['any_nv', 'NV', 'America/Los_Angeles'],
  ['lake_travis_tx', 'TX', 'America/Chicago'],           // outside the registry
  ['nowhere', 'ZZ', null],
  ['stateless', null, null],
]) check(`${slug} (${state}) → ${want}`, z(slug, state) === want, z(slug, state));

console.log('\n3. gameJson');
const row = (o = {}) => ({
  id: 1, season: 2026, date: new Date('2026-04-09T00:00:00Z'), datetime: new Date('2026-04-09T18:45:00Z'),
  status: 'scheduled', gameType: 'league', isForfeit: 0, isConference: 0, isOvertime: 0,
  homeScore: null, awayScore: null, homeSlug: 'boise_id', homeName: 'Boise', homeState: 'ID',
  awaySlug: 'rocky_mountain_id', awayName: 'Rocky Mountain', awayState: 'ID', venueName: null, ...o,
});
let g = gameJson(row());
check('Boise home game → America/Boise', g.timeZone === 'America/Boise', g.timeZone);
check('timeZone is the LAST key (additive, appended)', Object.keys(g).at(-1) === 'timeZone', Object.keys(g).slice(-3).join(','));
check('datetime unchanged', g.datetime instanceof Date && g.datetime.toISOString() === '2026-04-09T18:45:00.000Z');
check('dateKey unchanged', g.dateKey === '2026-04-09', g.dateKey);
g = gameJson(row({ homeSlug: 'coeur_d_alene_id', homeName: "Coeur d'Alene", awaySlug: 'boise_id', awayState: 'ID' }));
check("at Coeur d'Alene → the HOME team's zone (Pacific), not the away team's", g.timeZone === 'America/Los_Angeles', g.timeZone);
g = gameJson(row({ homeSlug: 'lake_travis_tx', homeState: 'TX' }));
check('Texas home team → America/Chicago', g.timeZone === 'America/Chicago', g.timeZone);
g = gameJson(row({ homeSlug: 'x', homeState: 'ZZ' }));
check('unknown home state → null, key still present', 'timeZone' in g && g.timeZone === null, J(g.timeZone));
g = gameJson(row({ datetime: null }));
check('no kickoff time → timeZone still given', g.timeZone === 'America/Boise' && g.datetime === null);

console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
