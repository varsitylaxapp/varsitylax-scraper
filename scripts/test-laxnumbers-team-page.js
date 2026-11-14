#!/usr/bin/env node
//
// test-laxnumbers-team-page.js — the team-page table parse on fixtures. No network.
// The rows are copied from Borah/Capital's 2026 page (team_info.php?y=2026&t=10878 shape).
//
//   node scripts/test-laxnumbers-team-page.js
//
// EXIT 0 all cases pass · 1 a case failed

const { parseLaxNumbersTeamGames } = require('../src/scrapers/laxnumbers');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const row = (date, opp, score) => `<tr>
    <td nowrap align=center><SPAN class=sitestyle1>${date}</span></td>
    <td nowrap align=center><SPAN class=sitestyle1>18:00</span></td>
    <td nowrap align=left><SPAN class=sitestyle1>${opp}</span></td>
    <td align=left><SPAN class=sitestyle1>n/a</span></td>
    <td nowrap align=center><SPAN class=sitestyle1>${score}</span></td>
  </tr>`;
const html = `<table><tr><th>Date</th><th>Time</th><th>Opponent</th><th>Loc</th><th>Score</th></tr>
${row('2026-04-10', `<em class='at-vs-ind'>at</em> <a href="team_info.php?y=2026&t=12983">Mountain View</a>`, '13 - 12')}
${row('2026-04-21', '<a href="team_info.php?y=2026&t=10879">Boise</a>', '9 - 8 2OT')}
${row('2026-04-22', '<a href="team_info.php?y=2026&amp;t=10880">Eagle</a>', '7 - 6 OT')}
${row('2026-05-07', '<a href="team_info.php?y=2026&t=10881">Emmett</a>', '1 - 0 (F)')}
${row('2026-05-20', 'vs Unlinked Prep', '-')}
${row('2026-05-21', '<a href="team_info.php?y=2026&t=10882">Kuna</a>', '9 - 8 OT2')}
</table>`;
const g = parseLaxNumbersTeamGames(html, { code: 'ID' }, 2026);
const by = d => g.find(x => x.date === d);

check('six game rows, header skipped', g.length === 6, String(g.length));
let x = by('2026-04-10');
check('opponent number from the link: Mountain View t=12983, away', x.opponentNbr === 12983 && x.opponentRaw === 'Mountain View' && !x.isHome, JSON.stringify(x));
x = by('2026-04-21');
check('"9 - 8 2OT" → scored 9–8, overtime', x.teamScore === 9 && x.oppScore === 8 && x.isOvertime && !x.isForfeit, JSON.stringify(x));
x = by('2026-04-22');
check('"7 - 6 OT" → still overtime', x.teamScore === 7 && x.isOvertime && x.opponentNbr === 10880, JSON.stringify(x));
x = by('2026-05-07');
check('"(F)" → forfeit, not overtime', x.isForfeit && !x.isOvertime && x.teamScore === 1, JSON.stringify(x));
x = by('2026-05-20');
check('no link → opponentNbr null; "-" → no result', x.opponentNbr === null && x.teamScore === null && x.opponentRaw === 'Unlinked Prep', JSON.stringify(x));
x = by('2026-05-21');
check('an unknown suffix ("OT2") is still refused as no result, not guessed', x.teamScore === null, JSON.stringify(x));

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — all checks'}`);
process.exit(failures ? 1 : 0);
