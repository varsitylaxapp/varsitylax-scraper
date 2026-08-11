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
  // STAGING AND REHEARSAL FREELY; PRODUCTION ONLY INSIDE A DECLARED WINDOW.
  //
  // The staging-only guard was right for as long as merges were a staging hygiene step,
  // and it is exactly how production came to carry the blanchet duplicate for two weeks
  // while the ruling sat in git looking done: the script that applies decisions could not
  // reach the database the decisions were about. Widening it is the point of window #5,
  // so the widening is explicit and narrow — prod needs BOTH --window and --commit, and
  // says so on the way in.
  const WINDOW = process.argv.includes('--window');
  if (db.targetLabel === 'prod' && !(WINDOW && COMMIT)) {
    console.error(`FATAL: target is prod. Production merges require --window --commit,`);
    console.error(`       and belong inside a rehearsed window (see RELEASE.md, window #5).`);
    process.exit(1);
  }
  if (db.targetLabel === 'prod') {
    console.log('*** PRODUCTION MERGE — declared window, decisions replayed from alias-decisions.json ***');
  }
  console.log(`\n=== apply-team-merges ===\ntarget: ${db.targetDescription}`);
  console.log(`mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

  const all = JSON.parse(fs.readFileSync('data/whsbla-2026/alias-decisions.json', 'utf8')).merges || [];
  // A SUPERSEDED DECISION IS STILL A DECISION, and it stays in the file — the trail is
  // the point. It must not be APPLIED, though, and the two brophy entries point in
  // opposite directions, so replaying the list blindly would merge a row and then merge
  // it back. Skipping on `superseded_by` is what makes "keep the history" safe.
  const merges = all.filter(m => !m.superseded_by);
  const skipped = all.length - merges.length;
  if (skipped) console.log(`  (${skipped} superseded ruling(s) skipped; they remain in the file with their reason)\n`);
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

    // ── A COLLIDING FIXTURE IS THE DEDUPE CASE, NOT AN ERROR ─────────────────
    //
    // Ruled 2026-08-10: window #3's cross-source dedupe in a new coat. When two identities
    // of one school each hold the same fixture, repointing hits `uq_game` — and that
    // collision is the correct signal, not a failure. Same natural key (season, date, the
    // third team) means one game recorded by two sources, so the higher-priority source
    // wins per `game_source_priority` (ohsla 100 > whsbla 90 > laxnumbers 50) and the twin
    // is deleted. Any field the two disagree on is logged to `source_conflicts` first —
    // deleting a row that said something different, without recording what it said, is how
    // a dedupe becomes a quiet edit of the record.
    //
    // The script aborted here before this existed, which is how the brophy and borah
    // collisions were found: on the dump, in the rehearsal, not in production.
    const twins = await q(
      `SELECT loser.id AS loserId, winner.id AS winnerId,
              loser.canonical_source AS loserSrc, winner.canonical_source AS winnerSrc,
              loser.home_score AS lhs, loser.away_score AS las, loser.status AS lst,
              winner.home_score AS whs, winner.away_score AS was, winner.status AS wst,
              loser.game_date AS d,
              (loser.home_team_id = ?) AS loserIsHome
       FROM games loser
       JOIN games winner
         ON winner.season = loser.season AND winner.game_date = loser.game_date
        AND winner.id <> loser.id
        AND (   (loser.home_team_id = ? AND winner.home_team_id = ? AND winner.away_team_id = loser.away_team_id)
             OR (loser.away_team_id = ? AND winner.away_team_id = ? AND winner.home_team_id = loser.home_team_id))
       WHERE loser.home_team_id = ? OR loser.away_team_id = ?`,
      [gone.id, gone.id, keep.id, gone.id, keep.id, gone.id, gone.id]);

    for (const t of twins) {
      const pri = await q(`SELECT source, priority FROM game_source_priority WHERE source IN (?, ?)`,
        [t.loserSrc, t.winnerSrc]);
      const p = Object.fromEntries(pri.map(r => [r.source, r.priority]));
      const loserWins = (p[t.loserSrc] ?? -1) > (p[t.winnerSrc] ?? -1);
      const [keepId, dropId] = loserWins ? [t.loserId, t.winnerId] : [t.winnerId, t.loserId];
      const [keepSrc, dropSrc] = loserWins ? [t.loserSrc, t.winnerSrc] : [t.winnerSrc, t.loserSrc];

      for (const [field, a, b] of [['home_score', t.whs, t.lhs], ['away_score', t.was, t.las],
                                   ['status', t.wst, t.lst]]) {
        if (String(a) === String(b)) continue;
        await q(
          `INSERT INTO source_conflicts (game_id, field, owner_source, owner_value, other_source, other_value, resolution)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [keepId, field, keepSrc, String(loserWins ? b : a), dropSrc, String(loserWins ? a : b),
           `merge ${m.merge_slug}->${m.keep_slug}: duplicate fixture, higher-priority source kept`]);
      }
      // Delete the twin only. If the SURVIVOR is the loser-identity's row it still points
      // at `gone` — the blanket repoint below moves it, and it can no longer collide
      // because the row it would have collided with is the one just deleted. Doing the
      // repoint here as well would be a second write of the same fact.
      await q(`DELETE FROM games WHERE id = ?`, [dropId]);
      console.log(`     dedupe ${String(t.d).slice(0, 10)}: kept #${keepId} (${keepSrc}) dropped #${dropId} (${dropSrc})`);
    }

    // repoint everything, then verify nothing is left pointing at the loser
    await q('UPDATE games SET home_team_id=? WHERE home_team_id=?', [keep.id, gone.id]);
    await q('UPDATE games SET away_team_id=? WHERE away_team_id=?', [keep.id, gone.id]);
    // SEASON ROWS AND RANKING ROWS COLLIDE THE SAME WAY ALIASES DO, and for a reason
    // created inside this very window: `seed-team-seasons.js` runs BEFORE the merges and
    // opens a 2026 row for every team with evidence — including the duplicate identity.
    // So by the time the merge runs, both rows have a season row, and repointing violates
    // `uq_team_seasons (team_id, season)`. The keeper's row is the one to keep; the
    // loser's is dropped and `refreshWinLoss` recomputes the record from the merged games
    // afterwards, so nothing is inherited from the row that goes away.
    //
    // Before this window the collision could not occur, because window #4-lite had never
    // created a season row for anyone in these states. Fixing one gap exposed the next.
    const movedSeasons = await q('UPDATE IGNORE team_seasons SET team_id=? WHERE team_id=?', [keep.id, gone.id]);
    const droppedSeasons = (await q('SELECT COUNT(*) n FROM team_seasons WHERE team_id=?', [gone.id]))[0].n;
    if (droppedSeasons) await q('DELETE FROM team_seasons WHERE team_id=?', [gone.id]);
    const movedRanks = await q('UPDATE IGNORE ranking_entries SET team_id=? WHERE team_id=?', [keep.id, gone.id]);
    const droppedRanks = (await q('SELECT COUNT(*) n FROM ranking_entries WHERE team_id=?', [gone.id]))[0].n;
    if (droppedRanks) await q('DELETE FROM ranking_entries WHERE team_id=?', [gone.id]);
    console.log(`     seasons moved=${movedSeasons.affectedRows} collided-and-dropped=${droppedSeasons}`
              + ` · rankings moved=${movedRanks.affectedRows} collided-and-dropped=${droppedRanks}`);
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
