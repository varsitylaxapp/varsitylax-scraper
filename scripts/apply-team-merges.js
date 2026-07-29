#!/usr/bin/env node
// Apply the `merges` rulings in alias-decisions.json. STAGING ONLY.
// Usage: node scripts/apply-team-merges.js --target=staging [--commit]
//
// A merge collapses two team rows that are the same school, reached under
// different names by different sources. Non-curated states have no roster lock,
// so nothing prevents this class of duplicate — merging is a prerequisite gate
// before a rankings-only state's scrape is ever enabled.
//
// Every reference is repointed before the losing row is deleted; the script
// refuses to delete a row that anything still references.
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const q = async (s, p = []) => (await db.execute(s, p))[0];

(async () => {
  if (db.targetLabel !== 'staging') {
    console.error(`FATAL: target is "${db.targetLabel}". Staging only.`); process.exit(1);
  }
  console.log(`\n=== apply-team-merges ===\ntarget: ${db.targetDescription}`);
  console.log(`mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

  const merges = JSON.parse(fs.readFileSync('data/whsbla-2026/alias-decisions.json', 'utf8')).merges || [];
  for (const m of merges) {
    const [keep] = await q('SELECT id,slug,name FROM teams WHERE slug=?', [m.keep_slug]);
    const [gone] = await q('SELECT id,slug,name FROM teams WHERE slug=?', [m.merge_slug]);
    if (!keep) { console.log(`  SKIP ${m.merge_slug}: keep row ${m.keep_slug} not found`); continue; }
    if (!gone) { console.log(`  DONE ${m.merge_slug}: already merged into ${m.keep_slug}`); continue; }
    console.log(`  ${m.merge_slug} (id ${gone.id}) -> ${m.keep_slug} (id ${keep.id})`);
    console.log(`     approved by ${m.approver}: ${m.basis}`);

    const refs = {
      games_home:   (await q('SELECT COUNT(*) n FROM games WHERE home_team_id=?', [gone.id]))[0].n,
      games_away:   (await q('SELECT COUNT(*) n FROM games WHERE away_team_id=?', [gone.id]))[0].n,
      team_seasons: (await q('SELECT COUNT(*) n FROM team_seasons WHERE team_id=?', [gone.id]))[0].n,
      rank_entries: (await q('SELECT COUNT(*) n FROM ranking_entries WHERE team_id=?', [gone.id]))[0].n,
      aliases:      (await q('SELECT COUNT(*) n FROM team_aliases WHERE team_id=?', [gone.id]))[0].n,
      unresolved:   (await q('SELECT COUNT(*) n FROM unresolved_aliases WHERE resolved_team_id=?', [gone.id]))[0].n,
    };
    console.log(`     references: ${JSON.stringify(refs)}`);

    if (!COMMIT) { console.log('     (dry run — no writes)\n'); continue; }

    // repoint everything, then verify nothing is left pointing at the loser
    await q('UPDATE games SET home_team_id=? WHERE home_team_id=?', [keep.id, gone.id]);
    await q('UPDATE games SET away_team_id=? WHERE away_team_id=?', [keep.id, gone.id]);
    await q('UPDATE team_seasons SET team_id=? WHERE team_id=?', [keep.id, gone.id]);
    await q('UPDATE ranking_entries SET team_id=? WHERE team_id=?', [keep.id, gone.id]);
    await q('UPDATE unresolved_aliases SET resolved_team_id=? WHERE resolved_team_id=?', [keep.id, gone.id]);
    // aliases move only where they don't collide with the keeper's existing set
    const moved = await q(
      `UPDATE IGNORE team_aliases SET team_id=? WHERE team_id=?`, [keep.id, gone.id]);
    const leftover = (await q('SELECT COUNT(*) n FROM team_aliases WHERE team_id=?', [gone.id]))[0].n;
    if (leftover) await q('DELETE FROM team_aliases WHERE team_id=?', [gone.id]);
    console.log(`     aliases moved=${moved.affectedRows} collided-and-dropped=${leftover}`);

    const still = (await q(
      `SELECT (SELECT COUNT(*) FROM games WHERE home_team_id=? OR away_team_id=?)
             +(SELECT COUNT(*) FROM team_seasons WHERE team_id=?)
             +(SELECT COUNT(*) FROM ranking_entries WHERE team_id=?)
             +(SELECT COUNT(*) FROM team_aliases WHERE team_id=?) AS n`,
      [gone.id, gone.id, gone.id, gone.id, gone.id]))[0].n;
    if (still > 0) { console.error(`     ABORT: ${still} references remain; not deleting`); process.exit(1); }
    await q('DELETE FROM teams WHERE id=?', [gone.id]);
    console.log(`     deleted team ${gone.id}; ${m.keep_slug} now carries both names\n`);
  }
  await db.end();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
