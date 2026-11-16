#!/usr/bin/env node
/**
 * Window #6, the two data items. The rehearsal and the production window run THIS
 * script, so what was rehearsed is what runs.
 *
 *   DB_TARGET=rehearsal node scripts/window6-data.js [--commit]       (rehearsal)
 *   node scripts/window6-data.js --window6 [--commit]                (production)
 *
 * Dry run by default: each item runs inside a transaction that is rolled back.
 *
 * ITEM A — section J's statements 2–5, re-run (RELEASE.md, window #6). The 10 WHSBLA
 *   forfeits were imported after partial-J, as `status_note = 'note=Forfeit'` with
 *   is_forfeit = 0. The statements are J's own, verbatim.
 * ITEM B — the Claremont ruling (de9fc76, data/whsbla-2026/alias-decisions.json):
 *   team_aliases "Claremont School 1" → claremont_bc, state BC, source laxnumbers.
 *
 * Each item is its own transaction: checks before, the statements, checks after, and
 * COMMIT only when every check holds. Anything else rolls back and exits 1. An item
 * whose end state is already in place is reported and skipped, so a re-run is a no-op.
 */
const pool = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const WINDOW = process.argv.includes('--window6');

// Pinned from the 2026-11-15 prod dump; ids are prod's, and the rehearsal restores prod.
const FORFEIT_IDS = [76032, 76159, 76200, 76274, 76293, 76314, 76324, 76355, 76356, 76376];
const FORFEIT_BEFORE = 5;                       // is_forfeit = 1 already (LaxNumbers ID/NV)
const NOTES_BEFORE = { 'note=Overtime': 29, 'note=Forfeit': 10, 'note=One Referee': 3, 'note=No Referees': 1 };
const NOTES_AFTER = { 'One Referee': 3, 'No Referees': 1 };
const ALIAS = { alias: 'Claremont School 1', state: 'BC', slug: 'claremont_bc', source: 'laxnumbers' };

let failures = 0;
const check = (label, ok, got) => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${label}${got !== undefined ? `  — ${got}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const J = x => JSON.stringify(x);

async function notes(c) {
  const [r] = await c.query(`SELECT status_note n, COUNT(*) k FROM games WHERE status_note IS NOT NULL GROUP BY status_note`);
  return Object.fromEntries(r.map(x => [x.n, Number(x.k)]));
}
async function one(c, sql, p = []) { const [r] = await c.query(sql, p); return Object.values(r[0])[0]; }

async function itemA(c) {
  console.log('\nA. section J statements 2–5 — the WHSBLA forfeit flags');
  const flagged = Number(await one(c, 'SELECT COUNT(*) FROM games WHERE is_forfeit = 1'));
  const n = await notes(c);
  const prefixed = Object.keys(n).filter(k => k.startsWith('note=')).length;
  const [onTen] = await c.query('SELECT COUNT(*) k FROM games WHERE is_forfeit = 1 AND id IN (?)', [FORFEIT_IDS]);
  if (prefixed === 0 && Number(onTen[0].k) === FORFEIT_IDS.length) {
    console.log(`   already applied: no note= rows, is_forfeit set on all 10 (${flagged} flagged in all) — skipped`);
    return;
  }

  await c.beginTransaction();
  try {
    console.log('   before:');
    const [ff] = await c.query(`SELECT id FROM games WHERE status_note = 'note=Forfeit' ORDER BY id`);
    check('note=Forfeit rows are exactly the 10 pinned ids', J(ff.map(r => r.id)) === J(FORFEIT_IDS), ff.map(r => r.id).join(','));
    check(`is_forfeit = 1 on ${FORFEIT_BEFORE} games`, flagged === FORFEIT_BEFORE, flagged);
    const same = (got, want) => Object.keys(got).length === Object.keys(want).length &&
      Object.entries(want).every(([k, v]) => got[k] === v);
    check('notes as measured on the dump', same(n, NOTES_BEFORE), J(n));
    const otLost = Number(await one(c, `SELECT COUNT(*) FROM games WHERE status_note = 'note=Overtime' AND is_overtime = 0`));
    check('every note=Overtime game already has is_overtime = 1 (deleting the note loses nothing)', otLost === 0, otLost);
    if (failures) throw new Error('a before-check failed');

    // Section J, statements 2–5, verbatim (migrations/section-j-forfeit-and-note-cleanup.sql).
    const rows = [];
    for (const sql of [
      `UPDATE games SET is_forfeit = 1 WHERE status_note = 'note=Forfeit'`,
      `UPDATE games SET status_note = NULL WHERE status_note = 'note=Overtime'`,
      `UPDATE games SET status_note = NULL WHERE status_note = 'note=Forfeit'`,
      `UPDATE games SET status_note = SUBSTRING(status_note, 6) WHERE status_note LIKE 'note=%'`,
    ]) { const [r] = await c.query(sql); rows.push(r.affectedRows); }
    console.log(`   J 2–5 rows changed: ${rows.join(' / ')}`);

    console.log('   after:');
    const after = Number(await one(c, 'SELECT COUNT(*) FROM games WHERE is_forfeit = 1'));
    check(`is_forfeit = 1: ${FORFEIT_BEFORE} → ${FORFEIT_BEFORE + FORFEIT_IDS.length}`, after === FORFEIT_BEFORE + FORFEIT_IDS.length, after);
    const [ten] = await c.query('SELECT COUNT(*) k FROM games WHERE is_forfeit = 1 AND id IN (?)', [FORFEIT_IDS]);
    check('…and the 10 added are the pinned ids', Number(ten[0].k) === FORFEIT_IDS.length, ten[0].k);
    const n2 = await notes(c);
    check('no note= prefix left; the officiating notes kept', same(n2, NOTES_AFTER), J(n2));
    if (failures) throw new Error('an after-check failed');

    if (COMMIT) { await c.commit(); console.log('   COMMITTED'); }
    else { await c.rollback(); console.log('   dry run — rolled back'); }
  } catch (err) {
    await c.rollback();
    console.log(`   ROLLED BACK: ${err.message}`);
  }
}

async function itemB(c) {
  console.log('\nB. the Claremont alias (ruling de9fc76)');
  const [t] = await c.query('SELECT id, state FROM teams WHERE slug = ?', [ALIAS.slug]);
  if (!check(`${ALIAS.slug} exists, state ${ALIAS.state}`, t.length === 1 && t[0].state === ALIAS.state, J(t))) return;
  const [have] = await c.query(
    `SELECT team_id, source FROM team_aliases WHERE state = ? AND alias_normalized = REPLACE(LOWER(TRIM(?)), '-', ' ')`,
    [ALIAS.state, ALIAS.alias]);
  if (have.length === 1 && have[0].team_id === t[0].id) {
    console.log('   already applied: the alias exists on claremont_bc — skipped');
    return;
  }
  check('no alias with that name in BC yet (the unique key would refuse it)', have.length === 0, J(have));
  if (failures) return;

  const before = Number(await one(c, 'SELECT COUNT(*) FROM team_aliases'));
  await c.beginTransaction();
  try {
    await c.query('INSERT INTO team_aliases (team_id, state, alias, source) VALUES (?, ?, ?, ?)',
      [t[0].id, ALIAS.state, ALIAS.alias, ALIAS.source]);
    const after = Number(await one(c, 'SELECT COUNT(*) FROM team_aliases'));
    check('team_aliases +1', after === before + 1, `${before} → ${after}`);
    if (failures) throw new Error('an after-check failed');
    if (COMMIT) { await c.commit(); console.log('   COMMITTED'); }
    else { await c.rollback(); console.log('   dry run — rolled back'); }
  } catch (err) {
    await c.rollback();
    console.log(`   ROLLED BACK: ${err.message}`);
  }
}

(async () => {
  if (pool.targetLabel === 'prod' && !WINDOW) {
    console.error('FATAL: against production this runs only as part of window #6: pass --window6');
    process.exit(1);
  }
  console.log(`window #6 data — ${COMMIT ? 'COMMIT' : 'DRY RUN (each item rolled back)'} — ${pool.targetDescription}`);
  const c = await pool.getConnection();
  try {
    await itemA(c);
    if (!failures) await itemB(c);
  } finally {
    c.release();
    await pool.end();
  }
  console.log(failures ? `\nFAIL — ${failures} check(s); nothing committed for the failing item` : '\nPASS — all checks');
  process.exit(failures ? 1 : 0);
})();
