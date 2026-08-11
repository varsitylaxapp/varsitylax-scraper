// New-schema write path (Phase 3). Used by index.js according to WRITE_MODE:
//   legacy (default) — old tables only (pre-E2 behavior)
//   dual             — both schemas (E2..E5.5 window)
//   v2               — new schema only (E6+)
//
// Alias resolution is done in JS against a per-run alias map, so no query ever
// joins across the legacy/new collation boundary (see docs/data-quirks.md).
const crypto = require('crypto');
const db = require('./db');
const { DEFAULT_STATE, listStates } = require('./config/states');
const { normalizeAlias } = require('./normalize');

const SEASON = parseInt(process.env.SEASON || '2026');
const PLACEHOLDER_OPPONENT = 'Team Place Holder';

// Delegates to the single shared definition — see src/normalize.js. Do not
// reimplement: it must match the SQL generated column exactly.
const norm = normalizeAlias;

// Which state a SOURCE speaks for. Derived from the registry, same table
// `scripts/cross-state-audit.js` derives — one fact, one derivation. `backfill` is the
// v1→v2 migration of the Oregon-only era and has no registry entry to read.
const SOURCE_STATE = { backfill: 'OR' };
for (const s of listStates()) {
  const label = s.scheduleSource && s.scheduleSource.label;
  if (label) SOURCE_STATE[label.toLowerCase()] = s.code;
}

// "4:30pm" + "2026-04-19" -> "2026-04-19 16:30:00" (naive Pacific, like the source).
// Returns null for missing/unparseable times (TBD games).
function parseGameDatetime(date, time) {
  if (!time) return null;
  const m = String(time).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return `${date} ${String(h).padStart(2, '0')}:${m[2]}:00`;
}

// ── Alias map: alias_normalized -> { teamId, slug, venueId, state } ──
// state omitted  -> every team, all states. Required by writeGames: an OHSLA
//                   schedule legitimately names out-of-state opponents.
// state supplied -> that state only. Required by writeRankings: a state's feed
//                   lists its teams under bare names, and bare names collide
//                   across states ("Mountain View" is both an Oregon alias for
//                   mt_view and a real WA school).
async function loadAliasMap(state) {
  const [rows] = await db.execute(
    `SELECT ta.alias_normalized AS a, t.id AS teamId, t.slug, t.home_venue_id AS venueId, t.state
     FROM team_aliases ta JOIN teams t ON t.id = ta.team_id
     ${state ? 'WHERE t.state = ?' : ''}`, state ? [state] : []);
  const map = new Map();
  for (const r of rows) map.set(r.a, r);
  return map;
}

// ── Alias CANDIDATES: alias_normalized -> [ {teamId, slug, venueId, state}, … ] ──
//
// The same query as above, keeping EVERY match instead of letting the last row win.
//
// `loadAliasMap` collapses candidates silently: `map.set(a, r)` in a loop means a name
// held by three schools in three states ends up as whichever row the database returned
// last. `writeGames` used it unscoped — correctly refusing to resolve inside one state,
// because an OHSLA schedule really does name out-of-state opponents — and thereby
// resolved "Liberty" to Washington's Liberty for Oregon's entire season. 36 games,
// invisible to every count, found in production by a WHSBLA board member reading his own
// league's schedule.
//
// The fix is not "scope it to one state"; that would drop the real cross-border fixtures.
// It is to keep the ambiguity and then RESOLVE it with the one fact the collapsed map
// threw away — which state the source speaks for. See `resolveSide`.
async function loadAliasCandidates() {
  const [rows] = await db.execute(
    `SELECT ta.alias_normalized AS a, t.id AS teamId, t.slug, t.home_venue_id AS venueId, t.state
     FROM team_aliases ta JOIN teams t ON t.id = ta.team_id`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.a)) map.set(r.a, []);
    const bucket = map.get(r.a);
    // Distinct TEAMS, not distinct alias rows: one team may legitimately hold the same
    // normalized alias twice (two spellings that normalize together). Counting rows
    // instead of teams would call that ambiguous and refuse to resolve it.
    if (!bucket.some(c => c.teamId === r.teamId)) bucket.push(r);
  }
  return map;
}

// Resolve one side of a scraped game to a team.
//
//   0 candidates          → unknown. Logged as unresolved, exactly as before.
//   1 candidate           → that team, whatever its state. This is the case the old
//                           map got right and must keep getting right: Mater Dei,
//                           Strake Jesuit and forty other tournament opponents exist
//                           only as out-of-state rows and are named unambiguously.
//   many, one local       → the local one. An OHSLA schedule saying "Liberty" means the
//                           Liberty that plays in OHSLA.
//   many, none local      → REFUSED. This is the re-import guard: the old code picked
//                           the last row and wrote it, which is how a phantom is minted
//                           silently. A refusal is loud, recoverable, and logged with
//                           every candidate it would not choose between.
//
// `sourceState` unknown (a source not in the registry) collapses "one local" to
// "none local", so an unregistered source can never guess either.
function resolveSide(candidates, sourceState) {
  if (!candidates || candidates.length === 0) return { team: null, reason: 'unknown' };
  if (candidates.length === 1) return { team: candidates[0] };
  const local = candidates.filter(c => c.state === sourceState);
  if (local.length === 1) return { team: local[0] };
  return { team: null, reason: 'ambiguous', candidates };
}

// A DIAGNOSTIC MUST NOT BE ABLE TO KILL ITS PATIENT.
//
// This function exists to make failures VISIBLE. It is not part of the write it
// observes, and it must never be able to end one. Two guards, both learned from the
// window #5 incident:
//
//   COERCE AT THE EDGE. Every bound value is forced to null when undefined. mysql2
//   rejects undefined outright, so one unset variable anywhere upstream turns a log
//   line into a thrown exception — which is exactly the inversion that took OHSLA's
//   sync down: the crash came through a path whose only job was to describe a refusal.
//
//   CONTAIN THE FAILURE. A throw inside unresolved-logging is caught, reported on
//   stderr, and swallowed. Losing a diagnostic row is a nuisance; losing the batch is
//   an outage. If logging is broken, the operator learns about it from the warning
//   while the games still land.
const nn = v => (v === undefined ? null : v);

async function logUnresolved(rawName, source, context, state = DEFAULT_STATE) {
  try {
    await db.execute(
      `INSERT INTO unresolved_aliases (raw_name, source, state, context, occurrence_count)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, context = VALUES(context)`,
      [nn(rawName), nn(source), nn(state), context ? String(context).slice(0, 256) : null]);
  } catch (err) {
    console.error(`[dual-write] unresolved-logging FAILED (write continues): ${err.message}`
                + `  raw=${JSON.stringify(rawName)} source=${JSON.stringify(source)} state=${JSON.stringify(state)}`);
  }
}

// ── Games: per-team perspective rows -> neutral matchup upserts ──────────────
// Returns { written, skipped, unresolved: [names] }
async function writeGames(scrapedGames, source = 'ohsla') {
  const aliases = await loadAliasCandidates();
  // Which state this source speaks for, from the registry — so a new state's league
  // arrives with its own scheduleSource label and needs no edit here.
  const sourceState = SOURCE_STATE[String(source).toLowerCase()];
  const unresolved = new Set();
  const ambiguous = [];
  const matchups = new Map(); // key season|homeId|awayId|date -> merged row

  for (const g of scrapedGames) {
    if (g.opponent === PLACEHOLDER_OPPONENT) continue;

    const ourR = resolveSide(aliases.get(norm(g.teamId)), sourceState);
    const oppR = resolveSide(aliases.get(norm(g.opponent)), sourceState);
    const our = ourR.team;
    const opp = oppR.team;

    // AMBIGUOUS IS NOT UNRESOLVED, and the two must not share a log line. "Unknown" means
    // we have never heard of this school and someone should add an alias. "Ambiguous"
    // means we know it too well — several schools answer to that name and the source did
    // not say which. Writing either one as a guess is what this window exists to undo.
    for (const [r, raw] of [[ourR, g.teamId], [oppR, g.opponent]]) {
      if (r.reason !== 'ambiguous') continue;
      ambiguous.push({ raw, source, candidates: r.candidates.map(c => `${c.state}:${c.slug}`) });
      await logUnresolved(raw, source,
        `AMBIGUOUS across states (${r.candidates.map(c => `${c.state}:${c.slug}`).join(', ')})`
        + ` — ${g.teamId} on ${g.date}`, sourceState);
    }

    if (!our) {
      unresolved.add(g.teamId);
      if (ourR.reason === 'unknown') await logUnresolved(g.teamId, source, `team_id, season ${g.season}`);
      continue;
    }
    if (!opp) {
      unresolved.add(g.opponent);
      if (oppR.reason === 'unknown') await logUnresolved(g.opponent, source, `opponent of ${g.teamId} on ${g.date}`);
      continue;
    }

    const homeSide = g.isHome ? our : opp;
    const awaySide = g.isHome ? opp : our;
    const row = {
      season: g.season, homeId: homeSide.teamId, awayId: awaySide.teamId,
      date: g.date, datetime: parseGameDatetime(g.date, g.time),
      venueId: homeSide.venueId || null,
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
        `UPDATE games SET home_team_id = ?, away_team_id = ?, game_datetime = ?, venue_id = ?,
           is_conference = ?, is_overtime = ?, home_score = ?, away_score = ?,
           status = ?, canonical_source = ?, source_updated_at = NOW()
         WHERE id = ?`,
        [m.homeId, m.awayId, m.datetime, m.venueId, m.isConference, m.isOvertime,
         m.homeScore, m.awayScore, status, source, reversed.id]);
      gameId = reversed.id;
    } else {
      const [r] = await db.execute(
        `INSERT INTO games (season, home_team_id, away_team_id, game_date, game_datetime, venue_id,
           is_conference, is_overtime, is_scrimmage, home_score, away_score,
           status, canonical_source, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           game_datetime = VALUES(game_datetime),
           venue_id = VALUES(venue_id), is_conference = VALUES(is_conference),
           is_overtime = VALUES(is_overtime), home_score = VALUES(home_score),
           away_score = VALUES(away_score),
           -- STALE IS STICKY UNLESS A SCORE ARRIVES. A plain status = VALUES(status)
           -- resurrected every aged-out fixture on the next scrape: OHSLA still
           -- lists them unscored, so the incoming status was 'scheduled' and it
           -- overwrote 'stale'. Now only a COMPLETED row -- one carrying scores --
           -- can revive a stale fixture, which is the auto-revival we want for a
           -- late score without the resurrection we do not.
           -- (No backticks in this comment: it sits inside a JS template literal.)
           status = IF(VALUES(status) = 'completed', 'completed',
                       IF(games.status = 'stale', 'stale', VALUES(status))),
           canonical_source = VALUES(canonical_source), source_updated_at = NOW(),
           id = LAST_INSERT_ID(id)`,
        [m.season, m.homeId, m.awayId, m.date, m.datetime, m.venueId,
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
    // THE SAME RESOLVER AS ABOVE, and it must be. This block is the second consumer
    // of `aliases` in this function, and when the map changed shape from
    // "name -> team" to "name -> [candidates]" it kept calling `.teamId` on what is
    // now an ARRAY. That yields `undefined`, which lands in scrapedTeamIds, is bound
    // into the prune query below, and takes the whole OHSLA write down with
    // "Bind parameters must not contain undefined".
    //
    // It reached production because the rehearsal exercised the REPAIR scripts against
    // a prod dump and never once called writeGames. See RELEASE.md, ledger member 9.
    const ourResolved = resolveSide(aliases.get(norm(g.teamId)), sourceState).team;
    if (ourResolved) scrapedTeamIds.add(ourResolved.teamId);
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
         -- SOURCE-SCOPED. A source may prune only what it owns, plus unclaimed
         -- rows that NO OTHER source has provenance for. The previous
         -- "canonical_source IS NULL" clause was a hole: once a second source
         -- writes games (WHSBLA, 2026-07-28), an OHSLA reschedule could delete
         -- a WHSBLA row that merely happened to have a NULL canonical_source.
         -- Verified by exploit test: the old predicate matched such a row, this
         -- one does not.
         AND (canonical_source = ?
              OR (canonical_source IS NULL AND NOT EXISTS (
                    SELECT 1 FROM game_source_records gsr
                     WHERE gsr.game_id = games.id AND gsr.source <> ?)))
         AND (home_team_id IN (${ph}) OR away_team_id IN (${ph}))`,
      [SEASON, source, source, ...ids, ...ids]);
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

  // AGE OUT unscored fixtures the source will never retire. Runs every cycle, for
  // every source, because OHSLA re-confirms months-dead fixtures on every scrape and
  // there is no reason to trust WHSBLA's export to behave better. See
  // src/stale-fixtures.js and docs/data-quirks.md.
  try {
    const { markStaleFixtures } = require('./stale-fixtures');
    const { marked, rows } = await markStaleFixtures(db, SEASON);
    if (marked) {
      console.log(`[dual-write] marked ${marked} fixture(s) stale: ` +
        rows.map(r => `#${r.id} ${r.d}`).join(', '));
    }
  } catch (err) {
    // Never fail a scrape over hygiene — but say so loudly.
    console.error('[dual-write] stale marking failed:', err.message);
  }

  await refreshWinLoss(SEASON);
  if (ambiguous.length) {
    // Loud on stdout as well as in unresolved_aliases: the cron's log is where a human
    // notices, and a refusal that only lands in a table nobody reads is a silent drop
    // wearing a better name.
    console.warn(`[dual-write] ${ambiguous.length} side(s) REFUSED as ambiguous across states:`);
    for (const a of ambiguous) console.warn(`    "${a.raw}" → ${a.candidates.join(' | ')}`);
  }
  return {
    written, pruned, skipped: unresolved.size, unresolved: [...unresolved],
    ambiguous,
  };
}

// ── Rankings: snapshot (hash-deduped) + entries ──────────────────────────────
// Returns { snapshotId|null (null = unchanged, skipped), entries, unresolved }
async function writeRankings(source, rankings, state = DEFAULT_STATE) {
  const aliases = await loadAliasMap(state);
  const season = rankings[0]?.season || SEASON;

  const resolved = [];
  const unresolved = [];
  for (const r of rankings) {
    const hit = aliases.get(norm(r.teamName));
    if (!hit) { unresolved.push(r.teamName); await logUnresolved(r.teamName, source, `rankings, season ${season}`, state); continue; }
    resolved.push({ ...r, teamId: hit.teamId });
  }

  // Content hash over resolved entries — new snapshot only when rankings changed.
  const hash = crypto.createHash('sha256').update(JSON.stringify(
    resolved.map(r => [r.teamId, r.rank, r.rating ?? r.consensus, r.wins, r.losses])
  )).digest('hex').slice(0, 64);

  const [[latest]] = await db.execute(
    `SELECT id, content_hash FROM rankings_snapshots
     WHERE source = ? AND season = ? AND state = ? ORDER BY captured_at DESC LIMIT 1`, [source, season, state]);
  if (latest && latest.content_hash === hash) {
    return { snapshotId: null, entries: 0, unresolved };
  }

  const [snap] = await db.execute(
    `INSERT INTO rankings_snapshots (source, state, season, captured_at, content_hash)
     VALUES (?, ?, ?, NOW(), ?)`,
    [source, state, season, hash]);
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
