#!/usr/bin/env node
//
// apply-cross-state-reassignment.js — resolve the duplicate fixtures that the
// cross-state collision minted, from `cross-state-audit.js --json`.
//
// WHAT IT UNDOES
//
// OHSLA emits one row per team perspective. "Liberty @ West Linn" arrives twice — once
// from Liberty's schedule, once from West Linn's — and `writeGames` merges them on
// `season|homeId|awayId|date`. When the unscoped alias map resolved West Linn's
// "Liberty" to Washington's Liberty and Liberty's own row to Oregon's, the merge key
// differed, so BOTH survived: two valid rows, each scored, each satisfying `uq_game`,
// one of them attached to a school 200 miles away in another state.
//
// The keeper is the row whose sides are in the source's own state. The other is deleted,
// not repointed — repointing would collide with `uq_game` against the keeper, which is
// the same collision that would have merged them correctly in the first place.
//
// WHAT IT DOES NOT DO
//
// Merges. A duplicate FIXTURE and a duplicate IDENTITY are different repairs:
// `apply-team-merges.js` collapses two team rows against a written ruling, and this
// script never creates, renames or deletes a team. If the audit reports mis-created rows
// (direction A), they are the merge's business and this script leaves them alone.
//
// PROVENANCE, HONESTLY. Deleting a game cascades its `game_source_records` row away
// (`fk_gsr_game ON DELETE CASCADE`), and that row cannot be moved to the keeper instead:
// `uq_game_source (game_id, source)` means the keeper already holds the only 'ohsla' slot.
// So one raw-name record per pair is genuinely lost — the mis-resolved perspective of a
// fixture that is fully described by the row that survives. The count is printed, because
// a silent loss of provenance is how a repair becomes indistinguishable from a mistake.
//
// USAGE
//     node scripts/cross-state-audit.js --json > /tmp/audit.json
//     node scripts/apply-cross-state-reassignment.js --plan /tmp/audit.json [--apply]
//
// Dry run is the DEFAULT.
//
// EXIT
//     0  ok (dry run, or applied and asserted)
//     1  refused, or a post-assertion failed — read the output
//     2  could not run

const fs = require('fs');
const db = require('./../src/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function flag(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  // Never take another flag as a value — ledger member 7.
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}

const PLAN = flag('plan');
if (!PLAN) { console.error('[reassign] FATAL: --plan <audit.json> is required'); process.exit(2); }

let plan;
try { plan = JSON.parse(fs.readFileSync(PLAN, 'utf8')); }
catch (e) { console.error(`[reassign] FATAL: cannot read plan: ${e.message}`); process.exit(2); }
if (!Array.isArray(plan.duplicatePairs)) { console.error('[reassign] FATAL: plan has no duplicatePairs'); process.exit(2); }

const q = async (s, p = []) => (await db.execute(s, p))[0];

// ── Is this pair really one fixture recorded twice? ──────────────────────────
//
// The audit produced the plan, but the plan is a FILE and the database is live: ids move,
// a previous run may have already deleted one side, a scrape may have changed a score.
// Every pair is re-proved here against the rows as they are NOW, and anything that does
// not re-prove is refused rather than repaired. A plan is a proposal, never a warrant.
async function verifyPair(p) {
  const rows = await q(
    `SELECT g.id, g.season, g.game_date, g.home_team_id, g.away_team_id,
            g.home_score, g.away_score, g.status, g.canonical_source,
            ht.slug hSlug, ht.state hState, at2.slug aSlug, at2.state aState
     FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams at2 ON at2.id = g.away_team_id
     WHERE g.id IN (?, ?)`, [p.keepGameId, p.dropGameId]);
  const keep = rows.find(r => r.id === p.keepGameId);
  const drop = rows.find(r => r.id === p.dropGameId);

  if (!drop) return { ok: false, why: 'drop row already gone — nothing to do', done: true };
  if (!keep) return { ok: false, why: 'keep row missing; refusing to delete the survivor' };
  if (String(keep.game_date).slice(0, 10) !== String(drop.game_date).slice(0, 10))
    return { ok: false, why: 'dates differ — not the same fixture' };
  if (keep.season !== drop.season) return { ok: false, why: 'seasons differ' };

  // They must share exactly one team — the real opponent — and differ on the other.
  const keepIds = [keep.home_team_id, keep.away_team_id];
  const dropIds = [drop.home_team_id, drop.away_team_id];
  const shared = keepIds.filter(id => dropIds.includes(id));
  if (shared.length !== 1) return { ok: false, why: `share ${shared.length} teams, expected exactly 1` };
  const keeperSide = keepIds.find(id => id !== shared[0]);
  const dropSide = dropIds.find(id => id !== shared[0]);

  // The two differing sides must be the same NAME in different states. If they are not,
  // this is two different fixtures on one day, not a collision.
  const [same] = await q(
    `SELECT COUNT(*) n FROM team_aliases a JOIN team_aliases b
       ON b.alias_normalized = a.alias_normalized AND b.team_id <> a.team_id
     WHERE a.team_id = ? AND b.team_id = ?`, [keeperSide, dropSide]);
  if (!same.n) return { ok: false, why: 'differing sides share no alias — not a name collision' };

  // Scores must agree where both exist. A disagreement means these rows are not two
  // records of one fixture and a human has to look.
  const bothScored = keep.home_score !== null && drop.home_score !== null;
  if (bothScored) {
    const keepPair = [keep.home_score, keep.away_score].sort().join('-');
    const dropPair = [drop.home_score, drop.away_score].sort().join('-');
    if (keepPair !== dropPair) return { ok: false, why: `scores disagree (${keepPair} vs ${dropPair})` };
  }

  // The keeper must be the row whose collided side is in the SOURCE's state; otherwise
  // the plan has them backwards and deleting would destroy the correct row.
  const [[keepTeam]] = [await q(`SELECT slug, state FROM teams WHERE id = ?`, [keeperSide])];
  const [[dropTeam]] = [await q(`SELECT slug, state FROM teams WHERE id = ?`, [dropSide])];
  if (`${keepTeam.state}:${keepTeam.slug}` !== p.keep || `${dropTeam.state}:${dropTeam.slug}` !== p.drop)
    return { ok: false, why: `plan/database disagree on sides (${keepTeam.state}:${keepTeam.slug} vs plan ${p.keep})` };

  return { ok: true, keep, drop, keepTeam, dropTeam, bothScored };
}

(async () => {
  console.log(`\n══ cross-state reassignment — ${plan.duplicatePairs.length} pair(s) proposed ══`);
  console.log(`   plan: ${PLAN}`);
  console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}\n`);

  const ready = [], refused = [], already = [];
  for (const p of plan.duplicatePairs) {
    const v = await verifyPair(p);
    if (v.ok) ready.push({ p, v });
    else if (v.done) already.push({ p, v });
    else refused.push({ p, v });
  }

  for (const { p, v } of ready) {
    console.log(`   ok      ${p.date}  delete #${p.dropGameId} (${p.drop})  keep #${p.keepGameId} (${p.keep})  vs ${p.sharedOpponent}${v.bothScored ? '' : '  [one side unscored]'}`);
  }
  for (const { p, v } of already) console.log(`   done    ${p.date}  #${p.dropGameId} — ${v.why}`);
  for (const { p, v } of refused) console.log(`   REFUSE  ${p.date}  #${p.dropGameId} — ${v.why}`);

  console.log(`\n   ${ready.length} ready · ${already.length} already done · ${refused.length} refused`);

  // A refusal is not a warning to scroll past. The window's claim is that the collision
  // is gone; a pair this script would not touch is a pair still in production.
  if (refused.length) {
    console.error(`\n   REFUSED PAIRS BLOCK THE WINDOW. Each one is a fixture this script`);
    console.error(`   cannot prove is a duplicate. Resolve them by hand or explain them.\n`);
    process.exit(1);
  }
  if (!APPLY) {
    console.log(`\n   DRY RUN — re-run with --apply to delete ${ready.length} duplicate row(s).\n`);
    process.exit(0);
  }

  let deleted = 0, provenanceLost = 0;
  for (const { p, v } of ready) {
    const [[gsr]] = [await q(`SELECT COUNT(*) n FROM game_source_records WHERE game_id = ?`, [p.dropGameId])];
    // Re-prove immediately before the write, inside the same run: the verification above
    // happened N pairs ago and this is a live database.
    const again = await verifyPair(p);
    if (!again.ok) { console.error(`   ABORT at ${p.date} #${p.dropGameId}: ${again.why}`); process.exit(1); }
    // CROSS-SOURCE DISAGREEMENTS ARE LOGGED; SAME-SOURCE ONES ARE NOT.
    //
    // The 36 Liberty/Lincoln pairs are both OHSLA — two perspectives of one scrape that
    // resolved apart — so there is no disagreement between SOURCES to record, and writing
    // `owner_source=ohsla other_source=ohsla` 36 times would bury the one row that matters.
    //
    // Borah 4/10 is the one that matters: OHSLA says Oregon's mt_view hosted Borah,
    // LaxNumbers' Idaho page says Idaho's mountain_view_id did. Ruled ONE game by two
    // oracles (alias-decisions.json `borah-mtview-2026-04-10`). The losing row is deleted,
    // and what it claimed is kept — the upstream page still says it, and a future import
    // that re-creates it must be recognisable as their error rather than ours.
    if (again.keep.canonical_source !== again.drop.canonical_source) {
      await db.execute(
        `INSERT INTO source_conflicts (game_id, field, owner_source, owner_value, other_source, other_value, resolution)
         VALUES (?, 'opponent_identity', ?, ?, ?, ?, ?)`,
        [p.keepGameId, again.keep.canonical_source, p.keep,
         again.drop.canonical_source, p.drop,
         `cross-state reassignment: one fixture recorded by two sources against different `
         + `identities of the same name; higher-priority source kept`]);
      console.log(`   conflict logged on #${p.keepGameId}: ${again.keep.canonical_source}=${p.keep} vs ${again.drop.canonical_source}=${p.drop}`);
    }
    const r = await q(`DELETE FROM games WHERE id = ?`, [p.dropGameId]);
    deleted += r.affectedRows;
    provenanceLost += gsr.n;
  }
  console.log(`\n   deleted ${deleted} duplicate game row(s); ${provenanceLost} source record(s) cascaded away`);

  // ── post-assertions ────────────────────────────────────────────────────────
  // Named, not counted. "36 rows deleted" is a receipt; "Washington's Liberty holds
  // eleven games, all WHSBLA, none against an Oregon team" is the claim being made.
  let failed = 0;
  const affected = [...new Set(plan.duplicatePairs.map(p => p.drop))];
  for (const who of affected) {
    const [, slug] = who.split(':');
    const rows = await q(`
      SELECT g.canonical_source AS src, opp.state AS oppState, COUNT(*) n
      FROM teams t
      JOIN games g ON t.id IN (g.home_team_id, g.away_team_id) AND g.season = ?
      JOIN teams opp ON opp.id = IF(g.home_team_id = t.id, g.away_team_id, g.home_team_id)
      WHERE t.slug = ? GROUP BY src, oppState`, [plan.season, slug]);
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    const foreign = rows.filter(r => r.oppState !== who.split(':')[0]);
    const detail = rows.map(r => `${r.src}/${r.oppState}=${r.n}`).join(' ');
    if (foreign.length) { console.error(`   FAIL  ${who}: still ${foreign.reduce((a, r) => a + Number(r.n), 0)} out-of-state game(s) — ${detail}`); failed++; }
    else console.log(`   ok    ${who}: ${total} game(s), all in-state — ${detail}`);
  }

  await require('./../src/dual-write').refreshWinLoss(plan.season);
  console.log(`   records recomputed for season ${plan.season}`);

  if (failed) { console.error(`\n   ${failed} assertion(s) failed\n`); process.exit(1); }
  console.log(`\n   done — re-run cross-state-audit.js; direction (B) must now be empty\n`);
  process.exit(0);
})().catch(err => { console.error('[reassign] FATAL:', err.message); process.exit(2); });
