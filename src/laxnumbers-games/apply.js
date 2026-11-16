/**
 * Every write the LaxNumbers game import makes. In dry run nothing here touches the
 * database; createTeam simulates, so the count ladder describes what a commit would do.
 *
 * THE WRITE RULE (diff 6, approved 2026-11-14). For each resolved game, in order:
 *   - either side an Oregon team  → nothing (flag 5: OHSLA owns Oregon). Decided in plan.js.
 *   - ruled out                    → nothing (data/ruled-out-games.json). plan.js.
 *   - no row yet                   → INSERT as laxnumbers, in every state, Washington
 *                                    included. A later WHSBLA export for the same game
 *                                    takes the row over: whsbla (90) outranks laxnumbers
 *                                    (50) in game_source_priority, so import-whsbla.js
 *                                    upserts onto the same uq_game key.
 *   - row owned by laxnumbers      → UPDATE only the fields that differ.
 *   - row owned by anyone else     → FILL only empty fields (both scores together,
 *                                    game_datetime, and scheduled/stale → completed when
 *                                    scores are filled). Never OT or forfeit: they are
 *                                    NOT NULL DEFAULT 0, so 0 is not "empty". Every other
 *                                    disagreement goes to source_conflicts and the
 *                                    owner's value stands — the import-whsbla.js rule.
 * Home/away is never flipped on an existing row. LaxNumbers' scores are mapped onto the
 * row's orientation before comparing, and a disagreement is reported.
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

/** The existing row for a game, by unordered pair, with times as strings (no zone math). */
async function findExisting(c, season, date, lo, hi) {
  const [[row]] = await c.execute(
    `SELECT id, canonical_source, home_team_id, away_team_id, home_score, away_score,
            is_overtime, is_forfeit, status,
            DATE_FORMAT(game_datetime, '%Y-%m-%d %H:%i:%s') AS dt
       FROM games
      WHERE season = ? AND game_date = ?
        AND LEAST(home_team_id, away_team_id) = ?
        AND GREATEST(home_team_id, away_team_id) = ? LIMIT 1`,
    [season, date, lo, hi]);
  return row ?? null;
}

/**
 * What to do with one game. Pure: no database, no clock.
 *   inc       { homeId, awayId, homeScore, awayScore, isOvertime, isForfeit, status, dt }
 *             status is 'completed' (scores present) or 'scheduled'; dt is Pacific
 *             "YYYY-MM-DD HH:MM:SS" or null.
 *   existing  the findExisting() row, or null
 * Returns { action: 'insert'|'update'|'fill'|'none', set, conflicts, flipped }.
 * Who owns the row decides update vs fill; the state does not.
 */
function decide(inc, existing) {
  if (!existing) return { action: 'insert', set: {}, conflicts: [], flipped: false };

  // LaxNumbers' view, in the row's orientation.
  const flipped = existing.home_team_id !== inc.homeId;
  const h = flipped ? inc.awayScore : inc.homeScore;
  const a = flipped ? inc.homeScore : inc.awayScore;
  const hasResult = inc.status === 'completed';
  const set = {}, conflicts = [];
  const num = v => (v === null || v === undefined ? null : Number(v));

  if (existing.canonical_source === 'laxnumbers') {
    if (hasResult) {
      if (num(existing.home_score) !== h) set.home_score = h;
      if (num(existing.away_score) !== a) set.away_score = a;
      if (num(existing.is_overtime) !== (inc.isOvertime ? 1 : 0)) set.is_overtime = inc.isOvertime ? 1 : 0;
      if (num(existing.is_forfeit) !== (inc.isForfeit ? 1 : 0)) set.is_forfeit = inc.isForfeit ? 1 : 0;
      if (existing.status !== 'completed') set.status = 'completed';
    }
    // A scheduled sighting never downgrades a result, and never revives a stale row.
    if (inc.dt && existing.dt !== inc.dt) set.game_datetime = inc.dt;
    return { action: Object.keys(set).length ? 'update' : 'none', set, conflicts, flipped };
  }

  // Owned by another source (or by nobody): fill empty fields, log the rest.
  const owner = existing.canonical_source ?? '(none)';
  const conflict = (field, ov, mv) => conflicts.push({ field, owner, owner_value: String(ov), other_value: String(mv) });
  if (flipped) conflict('home_away_orientation', `home_team_id=${existing.home_team_id}`, `home_team_id=${inc.homeId}`);
  if (hasResult) {
    if (existing.home_score === null && existing.away_score === null) {
      set.home_score = h; set.away_score = a;
      if (existing.status === 'scheduled' || existing.status === 'stale') set.status = 'completed';
    } else {
      if (existing.home_score !== null && num(existing.home_score) !== h) conflict('home_score', existing.home_score, h);
      if (existing.away_score !== null && num(existing.away_score) !== a) conflict('away_score', existing.away_score, a);
    }
    if (num(existing.is_overtime) !== (inc.isOvertime ? 1 : 0)) conflict('is_overtime', existing.is_overtime, inc.isOvertime ? 1 : 0);
    if (num(existing.is_forfeit) !== (inc.isForfeit ? 1 : 0)) conflict('is_forfeit', existing.is_forfeit, inc.isForfeit ? 1 : 0);
  }
  if (inc.dt) {
    if (existing.dt === null) set.game_datetime = inc.dt;
    else if (existing.dt !== inc.dt) conflict('game_datetime', existing.dt.replace(' ', 'T'), inc.dt.replace(' ', 'T'));
  }
  return { action: Object.keys(set).length ? 'fill' : 'none', set, conflicts, flipped };
}

/** Insert one game as laxnumbers. Returns the new id. */
async function insertGame(c, season, date, inc) {
  const [ins] = await c.execute(
    `INSERT INTO games (season, game_date, game_datetime, home_team_id, away_team_id,
                        home_score, away_score, status, game_type,
                        is_overtime, is_forfeit, canonical_source, source_updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'non_league', ?, ?, 'laxnumbers', NOW())`,
    [season, date, inc.dt, inc.homeId, inc.awayId, inc.homeScore, inc.awayScore, inc.status,
     inc.isOvertime ? 1 : 0, inc.isForfeit ? 1 : 0]);
  return ins.insertId;
}

const SETTABLE = new Set(['home_score', 'away_score', 'is_overtime', 'is_forfeit', 'status', 'game_datetime']);

/** Apply an update or fill. A fill re-checks emptiness in SQL, so it can never overwrite. */
async function applySet(c, gameId, set, fillOnly) {
  const cols = Object.keys(set);
  for (const k of cols) if (!SETTABLE.has(k)) throw new Error(`applySet: refusing column ${k}`);
  const guard = fillOnly
    ? cols.filter(k => k !== 'status').map(k => `AND ${k} IS NULL`).join(' ') : '';
  const [r] = await c.execute(
    `UPDATE games SET ${cols.map(k => `${k} = ?`).join(', ')}, source_updated_at = NOW()
      WHERE id = ? ${guard}`,
    [...cols.map(k => set[k]), gameId]);
  if (r.affectedRows !== 1) throw new Error(`applySet: game ${gameId} ${fillOnly ? 'fill' : 'update'} matched ${r.affectedRows} rows`);
}

async function logConflicts(c, gameId, conflicts) {
  for (const x of conflicts) {
    await c.execute(
      `INSERT INTO source_conflicts (game_id, field, owner_source, owner_value, other_source, other_value)
       VALUES (?, ?, ?, ?, 'laxnumbers', ?)
       ON DUPLICATE KEY UPDATE owner_value = VALUES(owner_value),
         other_value = VALUES(other_value), last_seen_at = NOW()`,
      [gameId, x.field, x.owner, x.owner_value, x.other_value]);
  }
}

/** LaxNumbers' own view of the game, written whether or not its values were applied. */
async function upsertSourceRecord(c, gameId, date, inc, names) {
  await c.execute(
    `INSERT INTO game_source_records
       (game_id, source, source_game_date, source_game_datetime, home_team_raw, away_team_raw,
        home_score, away_score, is_overtime, scraped_at)
     VALUES (?, 'laxnumbers', ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       source_game_date = VALUES(source_game_date), source_game_datetime = VALUES(source_game_datetime),
       home_team_raw = VALUES(home_team_raw), away_team_raw = VALUES(away_team_raw),
       home_score = VALUES(home_score), away_score = VALUES(away_score),
       is_overtime = VALUES(is_overtime), scraped_at = NOW()`,
    [gameId, date, inc.dt, names.home, names.away, inc.homeScore, inc.awayScore,
     inc.status === 'completed' ? (inc.isOvertime ? 1 : 0) : null]);
}

/**
 * Remove scheduled games this source owns that dropped out of the feed — the OHSLA rule
 * (src/dual-write.js), scoped to laxnumbers rows with no result and no Oregon side, among
 * teams whose pages were read this run. Refuses when the candidates exceed 20% of the
 * feed's games (a partial feed, not reschedules). Returns the ids removed.
 */
async function pruneVanished(c, season, teamIds, feedKeys, commit) {
  if (!teamIds.size || !feedKeys.size) return { pruned: [], refused: false };
  const ids = [...teamIds], ph = ids.map(() => '?').join(',');
  const [cands] = await c.execute(
    `SELECT g.id, g.home_team_id h, g.away_team_id a, DATE_FORMAT(g.game_date,'%Y-%m-%d') d
       FROM games g JOIN teams ht ON ht.id = g.home_team_id JOIN teams t2 ON t2.id = g.away_team_id
      WHERE g.season = ? AND g.status = 'scheduled' AND g.canonical_source = 'laxnumbers'
        AND g.home_score IS NULL AND g.away_score IS NULL
        AND NOT (ht.state <=> 'OR') AND NOT (t2.state <=> 'OR')
        AND (g.home_team_id IN (${ph}) OR g.away_team_id IN (${ph}))`,
    [season, ...ids, ...ids]);
  const stale = cands.filter(x => !feedKeys.has(`${x.d}|${Math.min(x.h, x.a)}|${Math.max(x.h, x.a)}`));
  if (stale.length > Math.max(5, Math.ceil(feedKeys.size * 0.2))) return { pruned: [], refused: true, candidates: stale.length };
  if (commit && stale.length) {
    await c.execute(`DELETE FROM games WHERE id IN (${stale.map(() => '?').join(',')})`, stale.map(s => s.id));
  }
  return { pruned: stale, refused: false };
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
    if (u.identity) console.log(`           IDENTITY CONFLICT: ${u.identity} — refused (laxnumbers_teams)`);
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

module.exports = { createTeam, findExisting, decide, insertGame, applySet, logConflicts,
                   upsertSourceRecord, pruneVanished, recordUnresolved };
