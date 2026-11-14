#!/usr/bin/env node
//
// test-live-games-registry.js — the registry keys the LaxNumbers game job reads.
// No network, no database.
//
//   node scripts/test-live-games-registry.js
//
// EXIT 0 all cases pass · 1 a case failed

const { listStates, rosterLockedStates, liveGameStates, parseLiveGamesStates } = require('../src/config/states');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

console.log('\n1. declarations');
check('roster-locked = OR, WA', JSON.stringify(rosterLockedStates()) === '["OR","WA"]', JSON.stringify(rosterLockedStates()));
const live = liveGameStates('laxnumbers').map(s => `${s.code}:${s.liveGames.role}`);
check('LaxNumbers game job: WA fill, AZ/ID/MT/NV primary',
  JSON.stringify(live) === '["WA:fill","AZ:primary","ID:primary","MT:primary","NV:primary"]', JSON.stringify(live));
check('Oregon declares no game job', listStates().find(s => s.code === 'OR').liveGames === null);
check('every state declares both keys', listStates().every(s => typeof s.rosterLocked === 'boolean' && 'liveGames' in s));

console.log('\n2. LAXNUMBERS_GAMES_STATES');
check('unset → off', JSON.stringify(parseLiveGamesStates(undefined)) === '[]');
check('blank → off', JSON.stringify(parseLiveGamesStates('  ')) === '[]');
check('"id, wa" → [ID, WA]', JSON.stringify(parseLiveGamesStates('id, wa')) === '["ID","WA"]');
check('OR refused', throws(() => parseLiveGamesStates('OR'), /OR declares no laxnumbers game job/));
check('unknown refused', throws(() => parseLiveGamesStates('ID,CA'), /unknown state "CA"/));
check('duplicate refused', throws(() => parseLiveGamesStates('ID,id'), /ID listed twice/));

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
process.exit(failures ? 1 : 0);
