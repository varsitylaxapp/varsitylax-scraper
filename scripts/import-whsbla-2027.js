#!/usr/bin/env node
// One-off: seed WA season 2027 classifications from Brandon's DRAFT.
// STAGING ONLY. Usage: node scripts/import-whsbla-2027.js --target=staging [--commit]
//
// This is a SEPARATE SEASON, not a correction to 2026.
//
// The 2027 draft moves 17 teams out of PV/OPEN, which looks at first like the
// 2026 provisional classification being wrong. It is not: the 2026 playoff
// bracket bucketed by that exact classification produced four perfect
// single-elimination trees (n teams / n-1 games, intra-class finals), including
// wa_private at 16 teams / 15 games. Seventeen misclassified teams could not
// produce that result. WHSBLA's Open division historically absorbed public
// schools that opted in; 2027 is a real realignment.
//
// Therefore: 2026 keeps division_source='laxnumbers_provisional' untouched, and
// the October final supersedes THIS row set (2027) wholesale.
//
// Teams are never created here BY INFERENCE — WA is roster-locked. An unmatched
// draft name is FLAGGED, never guessed.
//
// The one exception is a recorded ROSTER ADMISSION in alias-decisions.json: a
// team admitted by LEAGUE AUTHORITY (it appears in the league's own official
// file). That is the league speaking, not the importer guessing. Admissions
// carry an approver, evidence, and a reversal rule.
require('dotenv').config();
const { execFileSync } = require('child_process');
const db = require('../src/db');
const { normalizeAlias } = require('../src/normalize');

const SEASON = 2027;
const SOURCE = 'whsbla_draft_2027';
const COMMIT = process.argv.includes('--commit');
const VENV = '/private/tmp/claude-501/-Users-spencerwelch/7a623416-fb8e-45d8-a2d2-ea2c871e5dd2/scratchpad/phasef/venv/bin/python';

const CLASS_TO_DIV = { '4A': 'wa_4a', '3A': 'wa_3a', '2A': 'wa_2a', 'PV/OPEN': 'wa_private' };
const loose = s => String(s || '').toLowerCase().trim()
  .replace(/\b(high school|hs|high)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function q(sql, p = []) { const [r] = await db.execute(sql, p); return r; }

(async () => {
  if (db.targetLabel !== 'staging') {
    console.error(`FATAL: target is "${db.targetLabel}". Staging only.`); process.exit(1);
  }
  console.log(`\n=== import-whsbla-2027 (draft) ===`);
  console.log(`target: ${db.targetDescription}`);
  console.log(`mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN'}   season=${SEASON} source=${SOURCE}\n`);

  const raw = execFileSync(VENV, ['-c', `
import openpyxl, json
ws = openpyxl.load_workbook('data/whsbla-2026/Classifications-2027-draft.xlsx', data_only=True)['Teams']
rows = [r for r in ws.iter_rows(values_only=True) if r and r[0]]
print(json.dumps([{'name': str(r[0]).strip(), 'cls': str(r[1]).strip() if r[1] else None}
                  for r in rows[1:]]))`], { encoding: 'utf8' });
  const draft = JSON.parse(raw);
  console.log(`draft rows: ${draft.length}`);

  const DEC = JSON.parse(require('fs').readFileSync('data/whsbla-2026/alias-decisions.json', 'utf8'));
  const admissions = (DEC.roster_admissions || []).filter(a => a.admit_for_season === SEASON);
  console.log(`roster admissions for ${SEASON}: ${admissions.length}` +
    (admissions.length ? ` (${admissions.map(a => a.name).join(', ')})` : ''));

  const teams = await q("SELECT id, slug, name, state FROM teams WHERE state = 'WA'");
  const aliases = await q("SELECT team_id, alias_normalized FROM team_aliases WHERE state = 'WA'");
  const idx = new Map();
  for (const a of aliases) idx.set(a.alias_normalized, a.team_id);
  for (const t of teams) { idx.set(normalizeAlias(t.name), t.id); idx.set(normalizeAlias(t.slug), t.id); }
  const looseIdx = new Map();
  for (const t of teams) { looseIdx.set(loose(t.name), t.id); looseIdx.set(loose(t.slug), t.id); }
  for (const a of aliases) looseIdx.set(loose(a.alias_normalized), a.team_id);

  // Apply admissions BEFORE matching so the admitted team resolves normally.
  const admittedIds = new Map();
  for (const a of admissions) {
    let id = idx.get(normalizeAlias(a.name)) ?? looseIdx.get(loose(a.name)) ?? null;
    if (!id && COMMIT) {
      const r = await q(`INSERT INTO teams (slug, name, state) VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
        [a.slug, a.name, a.state]);
      id = r.insertId;
      for (const al of new Set([a.name, a.slug])) {
        await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
                 VALUES (?, ?, ?, ?)`, [id, a.state, al, a.division_source]);
      }
      // the ruling resolved it; retire the flag that asked for the ruling
      await q(`DELETE FROM unresolved_aliases WHERE raw_name = ? AND state = ?`, [a.name, a.state]);
      console.log(`  ADMITTED ${a.name} -> ${a.slug} (id ${id}) by ${a.approver}, ${a.basis}`);
    } else if (id) {
      console.log(`  admission ${a.name} already present as team id ${id}`);
    }
    if (id) { admittedIds.set(a.name, id); idx.set(normalizeAlias(a.name), id); looseIdx.set(loose(a.name), id); }
  }

  const matched = [], unmatched = [], badClass = [];
  for (const d of draft) {
    const div = CLASS_TO_DIV[d.cls];
    if (!div) { badClass.push(d); continue; }
    const id = idx.get(normalizeAlias(d.name)) ?? looseIdx.get(loose(d.name)) ?? null;
    if (!id) { unmatched.push(d); continue; }
    matched.push({ ...d, id, div });
  }

  console.log(`matched to existing WA teams : ${matched.length}`);
  console.log(`UNMATCHED (flagged, not guessed): ${unmatched.length}`);
  unmatched.forEach(u => console.log(`    ? ${u.name}  (${u.cls})`));
  if (badClass.length) { console.log(`unrecognised class labels: ${badClass.length}`); badClass.forEach(b => console.log(`    ! ${b.name} -> ${b.cls}`)); }

  const byDiv = {};
  matched.forEach(m => { byDiv[m.div] = (byDiv[m.div] || 0) + 1; });
  console.log(`\nper-division counts for ${SEASON}:`);
  for (const [k, v] of Object.entries(byDiv).sort()) console.log(`    ${k.padEnd(11)} ${v}`);

  if (COMMIT) {
    for (const m of matched) {
      await q(`INSERT INTO team_seasons (team_id, season, division_id, division_source)
               VALUES (?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE division_id = VALUES(division_id),
                 division_source = VALUES(division_source)`,
        [m.id, SEASON, m.div, SOURCE]);
    }
    for (const u of unmatched) {
      await q(`INSERT INTO unresolved_aliases (raw_name, source, state, context, occurrence_count)
               VALUES (?, ?, 'WA', ?, 1)
               ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, context = VALUES(context)`,
        [u.name, SOURCE, `2027 draft classification ${u.cls}; WA roster-locked, needs a human ruling`]);
    }
    console.log(`\nwrote ${matched.length} team_seasons rows for ${SEASON}`);
  } else {
    console.log(`\n(dry run — nothing written)`);
  }
  await db.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
