/**
 * Every write the LaxNumbers game import makes. In dry run nothing here touches the
 * database; createTeam simulates, so the count ladder describes what a commit would do.
 */
const { norm, loose, slugify } = require('./resolve');

/** Create a team we do not have. Provenance always; never silently. */
async function createTeam(ctx, name, stateCode, suffix, why) {
  const { c, ix } = ctx;
  const { idx, looseIdx, teamState, stateIdx, stateLooseIdx, candStrict, candLoose, addCand } = ix;
  const slug = slugify(name, suffix);
  if (!ctx.commit) {
    const id = ctx.fakeId--;
    idx.set(norm(name), id); looseIdx.set(loose(name), id);
    addCand(candStrict, norm(name), id); addCand(candLoose, loose(name), id);
    teamState.set(id, stateCode ?? null);
    if (stateCode) {
      if (!stateIdx.has(stateCode)) { stateIdx.set(stateCode, new Map()); stateLooseIdx.set(stateCode, new Map()); }
      stateIdx.get(stateCode).set(norm(name), id);
      stateLooseIdx.get(stateCode).set(loose(name), id);
    }
    return id;
  }
  const [r] = await c.execute(
    `INSERT INTO teams (slug, name, state) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
    [slug, name, stateCode]);
  const id = r.insertId;
  await c.execute(
    `INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
     VALUES (?,?,?, 'laxnumbers')`, [id, stateCode, name]);
  idx.set(norm(name), id); looseIdx.set(loose(name), id);
  addCand(candStrict, norm(name), id); addCand(candLoose, loose(name), id);
  teamState.set(id, stateCode ?? null);
  if (stateCode) {
    if (!stateIdx.has(stateCode)) { stateIdx.set(stateCode, new Map()); stateLooseIdx.set(stateCode, new Map()); }
    stateIdx.get(stateCode).set(norm(name), id);
    stateLooseIdx.get(stateCode).set(loose(name), id);
  }
  return id;
}

/** Insert one completed game with its provenance row. */
async function insertGame(c, season, g, homeId, awayId) {
  const [ins] = await c.execute(
    `INSERT INTO games (season, game_date, home_team_id, away_team_id,
                        home_score, away_score, status, game_type,
                        is_overtime, is_forfeit, canonical_source)
     VALUES (?,?,?,?,?,?, 'completed', 'non_league', ?, ?, 'laxnumbers')`,
    [season, g.date, homeId, awayId,
     g.isHome ? g.teamScore : g.oppScore,
     g.isHome ? g.oppScore : g.teamScore,
     g.isOvertime ? 1 : 0, g.isForfeit ? 1 : 0]);
  await c.execute(
    `INSERT INTO game_source_records (game_id, source, scraped_at)
     VALUES (?, 'laxnumbers', NOW())
     ON DUPLICATE KEY UPDATE scraped_at = VALUES(scraped_at)`, [ins.insertId]);
}

/** The long tail, for rulings: printed, and recorded in unresolved_aliases on commit. */
async function recordUnresolved(ctx) {
  const { c, report } = ctx;
  const tail = [...report.unresolved.values()].sort((a, b) => b.count - a.count);
  console.log(`\n  UNRESOLVED OPPONENTS: ${tail.length} distinct name(s)\n`);
  for (const u of tail) {
    console.log(`    ${String(u.count).padStart(3)}×  [${u.state}] ${u.raw}`);
    if (u.ambiguous) console.log(`           AMBIGUOUS: ${u.ambiguous} — refused, not picked`);
    if (u.foreign) console.log(`           FOREIGN ROW, NO RULING: ${u.foreign} — refused (data/foreign-row-rulings.json)`);
    if (u.number) console.log(`           BY TEAM NUMBER: ${u.number}`);
    u.samples.forEach(s => console.log(`           e.g. ${s}`));
    if (ctx.commit) {
      await c.execute(
        `INSERT INTO unresolved_aliases (raw_name, source, state, context, occurrence_count)
         VALUES (?, 'laxnumbers', ?, ?, ?)
         ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + VALUES(occurrence_count),
                                 last_seen_at = NOW()`,
        [u.raw, u.state, u.samples[0] ?? null, u.count]);
    }
  }
}

module.exports = { createTeam, insertGame, recordUnresolved };
