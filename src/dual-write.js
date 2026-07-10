// New-schema write path (Phase 3). Used by index.js according to WRITE_MODE:
//   legacy (default) — old tables only (pre-E2 behavior)
//   dual             — both schemas (E2..E5.5 window)
//   v2               — new schema only (E6+)
//
// Alias resolution is done in JS against a per-run alias map, so no query ever
// joins across the legacy/new collation boundary (see docs/data-quirks.md).
const crypto = require('crypto');
const db = require('./db');

const SEASON = parseInt(process.env.SEASON || '2026');
const PLACEHOLDER_OPPONENT = 'Team Place Holder';

function norm(s) { return String(s || '').trim().toLowerCase(); }

// ── Alias map: alias_normalized -> { teamId, slug, venueId, state } ──
async function loadAliasMap() {
  const [rows] = await db.execute(
    `SELECT ta.alias_normalized AS a, t.id AS teamId, t.slug, t.home_venue_id AS venueId, t.state
     FROM team_aliases ta JOIN teams t ON t.id = ta.team_id`);
  const map = new Map();
  for (const r of rows) map.set(r.a, r);
  return map;
}

async function logUnresolved(rawName, source, context) {
  await db.execute(
    `INSERT INTO unresolved_aliases (raw_name, source, context, occurrence_count)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, context = VALUES(context)`,
    [rawName, source, context ? context.slice(0, 256) : null]);
}

// ── Games: per-team perspective rows -> neutral matchup upserts ──────────────
// Returns { written, skipped, unresolved: [names] }
async function writeGames(scrapedGames, source = 'ohsla') {
  const aliases = await loadAliasMap();
  const unresolved = new Set();
  const matchups = new Map(); // key season|homeId|awayId|date -> merged row

  for (const g of scrapedGames) {
    if (g.opponent === PLACEHOLDER_OPPONENT) continue;

    const our = aliases.get(norm(g.teamId));
    const opp = aliases.get(norm(g.opponent));
    if (!our) { unresolved.add(g.teamId); await logUnresolved(g.teamId, source, `team_id, season ${g.season}`); continue; }
    if (!opp) { unresolved.add(g.opponent); await logUnresolved(g.opponent, source, `opponent of ${g.teamId} on ${g.date}`); continue; }

    const homeSide = g.isHome ? our : opp;
    const awaySide = g.isHome ? opp : our;
    const row = {
      season: g.season, homeId: homeSide.teamId, awayId: awaySide.teamId,
      date: g.date, venueId: homeSide.venueId || null,
      isConference: g.isConference ? 1 : 0, isOvertime: g.isOT ? 1 : 0,
      homeScore: g.isHome ? g.teamScore : g.oppScore,
      awayScore: g.isHome ? g.oppScore : g.teamScore,
      homeRaw: g.isHome ? g.teamId : g.opponent,
      awayRaw: g.isHome ? g.opponent : g.teamId,
      fromHomePerspective: !!g.isHome,
    };
    const key = `${row.season}|${row.homeId}|${row.awayId}|${row.date}`;
    const existing = matchups.get(key);
    // Prefer the home team's perspective; otherwise prefer the row that has scores.
    if (!existing || (row.fromHomePerspective && !existing.fromHomePerspective) ||
        (existing.homeScore === null && row.homeScore !== null)) {
      matchups.set(key, row);
    }
  }

  let written = 0;
  for (const m of matchups.values()) {
    const status = m.homeScore !== null && m.awayScore !== null ? 'completed' : 'scheduled';

    // Orientation-flip guard: if this matchup already exists with home/away
    // swapped, update that row (with flipped orientation) instead of inserting
    // a mirrored duplicate that uq_game cannot absorb.
    const [[reversed]] = await db.execute(
      `SELECT id FROM games WHERE season = ? AND home_team_id = ? AND away_team_id = ? AND game_date = ?`,
      [m.season, m.awayId, m.homeId, m.date]);
    let gameId;
    if (reversed) {
      await db.execute(
        `UPDATE games SET home_team_id = ?, away_team_id = ?, venue_id = ?,
           is_conference = ?, is_overtime = ?, home_score = ?, away_score = ?,
           status = ?, canonical_source = ?, source_updated_at = NOW()
         WHERE id = ?`,
        [m.homeId, m.awayId, m.venueId, m.isConference, m.isOvertime,
         m.homeScore, m.awayScore, status, source, reversed.id]);
      gameId = reversed.id;
    } else {
      const [r] = await db.execute(
        `INSERT INTO games (season, home_team_id, away_team_id, game_date, venue_id,
           is_conference, is_overtime, is_scrimmage, home_score, away_score,
           status, canonical_source, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           venue_id = VALUES(venue_id), is_conference = VALUES(is_conference),
           is_overtime = VALUES(is_overtime), home_score = VALUES(home_score),
           away_score = VALUES(away_score), status = VALUES(status),
           canonical_source = VALUES(canonical_source), source_updated_at = NOW(),
           id = LAST_INSERT_ID(id)`,
        [m.season, m.homeId, m.awayId, m.date, m.venueId,
         m.isConference, m.isOvertime, m.homeScore, m.awayScore, status, source]);
      gameId = r.insertId;
    }

    await db.execute(
      `INSERT INTO game_source_records
         (game_id, source, source_game_date, home_team_raw, away_team_raw,
          home_score, away_score, is_overtime, is_conference, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         source_game_date = VALUES(source_game_date),
         home_team_raw = VALUES(home_team_raw), away_team_raw = VALUES(away_team_raw),
         home_score = VALUES(home_score), away_score = VALUES(away_score),
         is_overtime = VALUES(is_overtime), is_conference = VALUES(is_conference),
         scraped_at = NOW()`,
      [gameId, source, m.date, m.homeRaw, m.awayRaw,
       m.homeScore, m.awayScore, m.isOvertime, m.isConference]);
    written++;
  }

  // ── Prune: mirror semantics for a mutable schedule ──────────────────────────
  // When OHSLA reschedules a game, its natural key (date) changes: the live path
  // inserts the new-date row and the old-date row is orphaned as a phantom
  // 'scheduled' entry. Cancellations orphan the same way. Prune v2 rows that:
  //   - are scheduled with no scores (never completed — nothing to lose),
  //   - belong to this source (or are unclaimed backfill rows),
  //   - involve a team whose page was SUCCESSFULLY scraped this run
  //     (a failed page yields zero rows — its games are protected), and
  //   - whose unordered pair+date no longer appears in the current feed.
  const scrapedTeamIds = new Set();
  for (const g of scrapedGames) {
    const our = aliases.get(norm(g.teamId));
    if (our) scrapedTeamIds.add(our.teamId);
  }
  const feedKeys = new Set();
  for (const m of matchups.values()) {
    feedKeys.add(`${Math.min(m.homeId, m.awayId)}|${Math.max(m.homeId, m.awayId)}|${m.date}`);
  }

  let pruned = 0;
  if (scrapedTeamIds.size > 0 && matchups.size > 0) {
    const ids = [...scrapedTeamIds];
    const ph = ids.map(() => '?').join(',');
    const [candidates] = await db.execute(
      `SELECT id, home_team_id AS h, away_team_id AS a,
              DATE_FORMAT(game_date, '%Y-%m-%d') AS d
       FROM games
       WHERE season = ? AND status = 'scheduled'
         AND home_score IS NULL AND away_score IS NULL
         AND (canonical_source IS NULL OR canonical_source = ?)
         AND (home_team_id IN (${ph}) OR away_team_id IN (${ph}))`,
      [SEASON, source, ...ids, ...ids]);
    const stale = candidates.filter(c =>
      !feedKeys.has(`${Math.min(c.h, c.a)}|${Math.max(c.h, c.a)}|${c.d}`));

    // Circuit breaker: a large stale set means a broken/partial feed, not real
    // reschedules. Never prune more than 20% of the current feed's matchup count.
    if (stale.length > Math.max(5, Math.ceil(matchups.size * 0.2))) {
      console.warn(`[dual-write] PRUNE SKIPPED: ${stale.length} stale candidates vs ${matchups.size} feed matchups — feed looks partial, refusing to prune`);
    } else if (stale.length > 0) {
      const [del] = await db.execute(
        `DELETE FROM games WHERE id IN (${stale.map(() => '?').join(',')})`,
        stale.map(s => s.id)); // game_source_records rows cascade
      pruned = del.affectedRows;
      console.log(`[dual-write] pruned ${pruned} stale scheduled game(s): ` +
        stale.map(s => `#${s.id} ${s.d}`).join(', '));
    }
  }

  await refreshWinLoss(SEASON);
  return { written, pruned, skipped: unresolved.size, unresolved: [...unresolved] };
}

// ── Rankings: snapshot (hash-deduped) + entries ──────────────────────────────
// Returns { snapshotId|null (null = unchanged, skipped), entries, unresolved }
async function writeRankings(source, rankings) {
  const aliases = await loadAliasMap();
  const season = rankings[0]?.season || SEASON;

  const resolved = [];
  const unresolved = [];
  for (const r of rankings) {
    const hit = aliases.get(norm(r.teamName));
    if (!hit) { unresolved.push(r.teamName); await logUnresolved(r.teamName, source, `rankings, season ${season}`); continue; }
    resolved.push({ ...r, teamId: hit.teamId });
  }

  // Content hash over resolved entries — new snapshot only when rankings changed.
  const hash = crypto.createHash('sha256').update(JSON.stringify(
    resolved.map(r => [r.teamId, r.rank, r.rating ?? r.consensus, r.wins, r.losses])
  )).digest('hex').slice(0, 64);

  const [[latest]] = await db.execute(
    `SELECT id, content_hash FROM rankings_snapshots
     WHERE source = ? AND season = ? ORDER BY captured_at DESC LIMIT 1`, [source, season]);
  if (latest && latest.content_hash === hash) {
    return { snapshotId: null, entries: 0, unresolved };
  }

  const [snap] = await db.execute(
    `INSERT INTO rankings_snapshots (source, season, captured_at, content_hash) VALUES (?, ?, NOW(), ?)`,
    [source, season, hash]);
  const snapshotId = snap.insertId;

  // Source duplicates (e.g. laxpower double-listing) absorbed by PK — keep first-listed.
  let entries = 0;
  for (const r of resolved) {
    const [res] = await db.execute(
      `INSERT IGNORE INTO ranking_entries
         (snapshot_id, team_id, rank_position, rating, agd, sched, record_wins, record_losses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [snapshotId, r.teamId, r.rank, r.rating ?? r.consensus ?? 0,
       r.agd ?? null, r.sched ?? null, r.wins ?? null, r.losses ?? null]);
    entries += res.affectedRows;
  }
  return { snapshotId, entries, unresolved };
}

// ── team_seasons W-L cache refresh (same semantics as runbook D6) ────────────
async function refreshWinLoss(season) {
  await db.execute(
    `UPDATE team_seasons ts
     LEFT JOIN v_team_season_record v ON v.team_id = ts.team_id AND v.season = ts.season
     SET ts.wins = COALESCE(v.wins, 0), ts.losses = COALESCE(v.losses, 0), ts.wl_computed_at = NOW()
     WHERE ts.season = ?`, [season]);
}

module.exports = { writeGames, writeRankings, refreshWinLoss };
