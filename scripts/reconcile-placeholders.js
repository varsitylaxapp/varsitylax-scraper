#!/usr/bin/env node
// Reconcile a7-era placeholder rows against a curated state's real roster.
// READ-ONLY. Reports candidates; merges nothing.
//
// Usage: node scripts/reconcile-placeholders.js WA --target=staging
//
// WHY THIS EXISTS. a7-classification.json seeded 31 out-of-state placeholder
// teams from Oregon's opponent list, long before the roster lock existed. When a
// state is later curated from its own league export, a school already present as
// an Oregon opponent under a DIFFERENT name becomes a duplicate that nothing
// prevents — the member-seeding path is the curator and is exempt from the lock
// by design.
//
// Two found by stumbling (brophy_prep_az, bishop_blanchet_wa) in two checks. This
// sweeps instead. Run it at the enablement gate for EVERY curated-state
// onboarding: the class exists wherever a7 touched.
//
// DESIGN PROPERTY, deliberately tuned: this OVER-REPORTS. Matching is loose and
// strips generic words (prep/academy/catholic/college), which collides real
// distinct schools — Seattle Prep vs Seattle Academy, Mount Si vs Mount Vernon.
// That is the correct trade. A false positive costs a human one minute of review;
// a false negative is an irreversible-feeling data bug that surfaces months later.
// Keep it tuned exactly here. Do not "improve" precision at the cost of recall.
//
// Pairs a human has ruled DISTINCT are recorded in alias-decisions.json under
// `do_not_merge` and suppressed below, so a rejected candidate is never
// re-proposed by a later sweep, tool, or session. Negative knowledge is knowledge.
require('dotenv').config();
const db = require('../src/db');
const { normalizeAlias } = require('../src/normalize');

const fs = require('fs');
const CODE = (process.argv[2] || '').toUpperCase();

const DECISIONS = JSON.parse(fs.readFileSync('data/whsbla-2026/alias-decisions.json', 'utf8'));
const REJECTED = new Set(
  (DECISIONS.do_not_merge || []).flatMap(r => [`${r.a}|${r.b}`, `${r.b}|${r.a}`]));
const MERGED = new Set(
  (DECISIONS.merges || []).flatMap(m => [`${m.keep_slug}|${m.merge_slug}`, `${m.merge_slug}|${m.keep_slug}`]));
const q = async (s, p = []) => (await db.execute(s, p))[0];

const loose = s => String(s || '').toLowerCase().trim()
  .replace(/\b(high school|highschool|hs|high|academy|preparatory|prep|catholic|college)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// token overlap, ignoring order and the stripped generic words
function affinity(a, b) {
  const ta = new Set(loose(a).split(' ').filter(Boolean));
  const tb = new Set(loose(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

(async () => {
  if (!CODE) { console.error('usage: reconcile-placeholders.js <STATE> --target=staging'); process.exit(2); }
  console.log(`\n=== reconcile-placeholders ${CODE} (READ-ONLY) ===`);
  console.log(`target: ${db.targetDescription}\n`);

  const teams = await q(
    `SELECT t.id, t.slug, t.name,
            (SELECT COUNT(*) FROM games g WHERE g.home_team_id=t.id OR g.away_team_id=t.id) games,
            (SELECT COUNT(*) FROM team_seasons ts WHERE ts.team_id=t.id) seasons,
            (SELECT COUNT(*) FROM ranking_entries re WHERE re.team_id=t.id) rankRows,
            (SELECT GROUP_CONCAT(DISTINCT ta.source ORDER BY ta.source) FROM team_aliases ta WHERE ta.team_id=t.id) sources
     FROM teams t WHERE t.state = ? ORDER BY t.slug`, [CODE]);

  const a7 = teams.filter(t => (t.sources || '').includes('a7-classification'));
  const curated = teams.filter(t => !(t.sources || '').includes('a7-classification'));
  console.log(`${CODE} rows: ${teams.length}   a7-era placeholders: ${a7.length}   curated: ${curated.length}`);
  console.log(`suppressed by prior rulings: ${REJECTED.size / 2} do-not-merge, ${MERGED.size / 2} already-merged\n`);

  const exact = [], likely = [], possible = [], clean = [];
  for (const p of a7) {
    // an a7 row that later gained seasons/rankings was itself adopted as curated
    const scored = curated
      .map(c => ({ c, score: affinity(p.name, c.name), normEq: normalizeAlias(p.name) === normalizeAlias(c.name) }))
      .filter(x => x.score > 0)
      .filter(x => !REJECTED.has(`${p.slug}|${x.c.slug}`))   // human ruled DISTINCT
      .filter(x => !MERGED.has(`${p.slug}|${x.c.slug}`))     // already ruled a merge
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top) { clean.push(p); continue; }
    const bucket = top.normEq ? exact : top.score >= 0.99 ? likely : top.score >= 0.5 ? possible : null;
    if (bucket) bucket.push({ p, ...top, runnersUp: scored.slice(1, 3) });
    else clean.push(p);
  }

  const row = t => `${t.slug} (id ${t.id})  games=${t.games} seasons=${t.seasons} rank=${t.rankRows}`;
  const verdict = (p, c) => {
    // keeper = the row carrying more, never decided by which source created it
    const wp = p.games + p.seasons * 2 + p.rankRows * 2;
    const wc = c.games + c.seasons * 2 + c.rankRows * 2;
    return wp === wc ? 'TIE — needs a human call' : (wp > wc ? `KEEP ${p.slug}` : `KEEP ${c.slug}`);
  };

  const report = (title, list) => {
    console.log(`── ${title}: ${list.length} ──`);
    for (const { p, c, score, runnersUp } of list) {
      console.log(`  placeholder  ${row(p)}   "${p.name}"`);
      console.log(`  candidate    ${row(c)}   "${c.name}"   affinity=${score.toFixed(2)}`);
      console.log(`  -> ${verdict(p, c)}`);
      if (runnersUp.length) console.log(`     other candidates: ${runnersUp.map(r => `${r.c.slug}(${r.score.toFixed(2)})`).join(', ')}`);
      console.log('');
    }
  };
  report('EXACT — normalized names identical', exact);
  report('LIKELY — same tokens after stripping generics', likely);
  report('POSSIBLE — partial token overlap, review carefully', possible);

  console.log(`── NO CANDIDATE: ${clean.length} ──`);
  for (const p of clean) console.log(`  ${row(p)}   "${p.name}"`);

  console.log(`\nsummary: exact=${exact.length} likely=${likely.length} possible=${possible.length} clean=${clean.length}`);
  console.log('NOTHING MERGED. Add approved pairs to alias-decisions.json `merges`,');
  console.log('then run scripts/apply-team-merges.js.\n');
  await db.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
