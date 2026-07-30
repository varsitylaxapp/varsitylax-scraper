#!/usr/bin/env node
/**
 * Record parity, with an oracle anchored OUTSIDE the database.
 *
 * WHY THE PREVIOUS VERSION OF THIS CHECK WAS INSUFFICIENT. It replicated the app's
 * W–L computation over the API's /schedule/all payload and diffed it against
 * `v_team_season_record`, reporting "116 teams compared, 0 mismatched". Both sides
 * were fed by the same `games` rows — so when six games were duplicated, BOTH
 * double-counted them and agreed. The check proved CONSISTENCY between two consumers
 * of one table. It could not, even in principle, detect that the table was wrong.
 *
 * A parity check between two consumers of the same source can never catch what that
 * source gets wrong. So this version does both:
 *
 *   PART 1  consistency — client computation vs the server view (as before)
 *   PART 2  GROUND TRUTH — hardcoded expected records, asserted from outside. These
 *           come from the ruling and the audit trail, NOT from a query, which is the
 *           entire point. If the database drifts from them, this fails.
 *
 *   node scripts/verify-record-parity.js --target=staging
 */
const pool = require('../src/db');
const HOST = process.env.VLX_API || 'http://localhost:3000';
const SEASON = 2026;

const isScrimmage = t => t === 'exhibition' || t === 'practice';

/**
 * GROUND TRUTH — established by ruling and audit, not by querying the thing under
 * test. Each entry records WHY it is what it is, so a future failure is diagnosable
 * rather than just red.
 */
const ORACLE = [
  ['richland_wa', 18, 4,
   'Was 18-5. The nelson/richland_wa game was ingested twice with opposite ' +
   'orientation; one copy was a phantom loss. Deduped 2026-07-29, keeper #170.'],
  ['nelson', 14, 4,
   'Was 15-4 — same duplicate, counted as two wins for Clackamas/Nelson.'],
  ['bend_caldera', 6, 6,
   'Was 6-7. Duplicate of the faith_lutheran_nv game (non_league in both sources).'],
  ['faith_lutheran_nv', 1, 1,
   'Was 2-1 — the other side of that same duplicate.'],
  ['lakeridge', 15, 4,
   'Was 16-4 after dedupe. The palo_verde_nv game is an EXHIBITION per WHSBLA, ' +
   'adopted over OHSLA non_league, so it no longer counts.'],
  ['summit', 9, 6,
   'Was 9-7. Its claremont_bc game is a WHSBLA exhibition.'],
  ['grant', 11, 7,
   'Was 12-8. TWO exhibitions (nanaimo_bc, palo_verde_nv) — won one, lost one.'],
  ['palo_verde_nv', 2, 0,
   'Was 3-1. Two exhibitions against Oregon opposition, one each way.'],
  ['oes', 17, 1,
   'UNTOUCHED CONTROL. Oregon Episcopal played none of the affected games; if this ' +
   'moves, the dedupe or the merge reached further than intended.'],
  ['mount_si_wa', 19, 4,
   'UNTOUCHED CONTROL on the Washington side.'],
];

(async () => {
  let failures = 0;

  // ── PART 2 first: ground truth. If the table is wrong, say so before reporting
  //    a consistency result that would look reassuring.
  console.log('\n  PART 2 — GROUND TRUTH (oracle external to the database)\n');
  for (const [slug, w, l, why] of ORACLE) {
    const [[r]] = await pool.execute(
      `SELECT wins, losses FROM v_team_season_record r
         JOIN teams t ON t.id = r.team_id
        WHERE t.slug = ? AND r.season = ?`, [slug, SEASON]);
    const got = r ? `${r.wins}-${r.losses}` : 'MISSING';
    const want = `${w}-${l}`;
    const ok = got === want;
    if (!ok) failures++;
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${slug.padEnd(20)} expected ${want.padEnd(6)} got ${got}`);
    if (!ok) console.log(`          ${why}`);
  }

  // ── PART 1: consistency between the client computation and the server view.
  console.log('\n  PART 1 — CONSISTENCY (client computation vs v_team_season_record)\n');
  for (const [label, state, qs] of [['OR', 'OR', ''], ['WA', 'WA', '&state=WA']]) {
    const res = await fetch(`${HOST}/api/v2/schedule/all?season=${SEASON}${qs}`);
    if (!res.ok) { console.log(`    ${label}: API ${res.status} — skipped`); failures++; continue; }
    const { games } = await res.json();
    const rec = {};
    for (const g of games.filter(x => !isScrimmage(x.gameType))) {
      if (g.home.score == null || g.away.score == null) continue;
      const hw = g.home.score > g.away.score, aw = g.away.score > g.home.score;
      for (const [slug, won, lost] of [[g.home.slug, hw, aw], [g.away.slug, aw, hw]]) {
        rec[slug] ??= { w: 0, l: 0 };
        if (won) rec[slug].w++; else if (lost) rec[slug].l++;
      }
    }
    const [rows] = await pool.execute(
      `SELECT t.slug, r.wins, r.losses FROM v_team_season_record r
         JOIN teams t ON t.id = r.team_id
        WHERE r.season = ? AND t.state = ?`, [SEASON, state]);
    const bad = rows.filter(r => rec[r.slug] &&
      (rec[r.slug].w !== Number(r.wins) || rec[r.slug].l !== Number(r.losses)));
    const compared = rows.filter(r => rec[r.slug]).length;
    console.log(`    ${label}: ${compared} compared, ${bad.length} mismatched`);
    bad.slice(0, 8).forEach(r => console.log(
      `        ${r.slug}: client ${rec[r.slug].w}-${rec[r.slug].l} vs view ${r.wins}-${r.losses}`));
    failures += bad.length;
  }

  console.log(failures
    ? `\n  ${failures} FAILURE(S)\n`
    : '\n  ALL PASS — consistency AND ground truth\n');
  process.exitCode = failures ? 1 : 0;
  await pool.end();
})();
