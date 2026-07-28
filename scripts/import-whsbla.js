#!/usr/bin/env node
// One-off WHSBLA 2026 importer — STAGING ONLY.
//
// Source of truth is the league export (Brandon Fortier / WHSBLA), not a scrape.
// Membership is LEAGUE-DEFINED, not geographic: Hermiston is an Oregon-located
// WIAA school that competes in WHSBLA and is untagged in Teams.xlsx. Never
// geo-filter; the untagged Teams.xlsx list IS the membership filter.
//
// GAME ACCEPTANCE POLICY (ruling 2026-07-28)
// -----------------------------------------------------------------------------
// A game is accepted from a league export when AT LEAST ONE participant is
// either (a) a member of that league, or (b) a curated team of a launched state.
//
// Consequences for the WHSBLA 2026 export:
//   * 462 both-member games        -> accepted (a)
//   * 63  one-member games         -> accepted (a)
//   * 5   OR-team tournament games -> accepted (b): neither side is a WHSBLA
//         member, but Oregon is launched and these are real games its teams
//         played. Exhibition-typed, so standings-safe. provenance = whsbla.
//   * 1   Coronado (NV) @ Nanaimo (BC) -> REJECTED: touches nothing we serve.
//
// This deliberately makes Oregon's feed differ from OHSLA's book by those rows.
// That is policy, not drift.
//
// Usage:
//   node scripts/import-whsbla.js --target=staging [--commit]
// Without --commit it runs read-only and reports what it WOULD do.
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');
const { normalizeAlias } = require('../src/normalize');

const SP = '/private/tmp/claude-501/-Users-spencerwelch/7a623416-fb8e-45d8-a2d2-ea2c871e5dd2/scratchpad/phasef';
const SEASON = 2026;
const SOURCE = 'whsbla';

// ROSTER-LOCKED STATES (policy 2026-07-28). A state with a curated canonical
// roster may NEVER have teams auto-created by an importer. Unresolved names go
// to unresolved_aliases for human review and become alias-decisions.json
// entries. Placeholder creation stays allowed for non-curated states (the
// TX/TN/BC/CA opponents nobody maintains a roster for).
//
// OR is locked by OHSLA's curated 41. WA becomes locked by THIS import's 75 —
// the member-seeding path below is the curator and is therefore exempt; only
// the tagged-opponent path is gated.
const ROSTER_LOCKED = new Set(['OR', 'WA']);
const COMMIT = process.argv.includes('--commit');

// Divisions use the plan's key naming.
// RESOLVED 2026-07-28 by Brandon Fortier (WHSBLA): 1A was scrapped; the official
// divisions are 4A, 3A, 2A, PV/Open. Applied to 2026 as well as 2027 so there is
// no one-season-only "1A/2A" badge. The earlier TODO literal is dead and was
// never written to any database.
const DIVISIONS = [
  { id: 'wa_4a',      name: '4A',                 sort: 0, lax: '4A' },
  { id: 'wa_3a',      name: '3A',                 sort: 1, lax: '3A' },
  { id: 'wa_2a',      name: '2A',                 sort: 2, lax: '2A' },
  { id: 'wa_private', name: 'PV/Open',             sort: 3, lax: 'Private/Open' },
];

// TWO normalizations, deliberately distinct:
//   normalizeAlias — EXACT parity with the SQL generated column. Used for every
//     team_aliases lookup. Using anything else here reproduces the 2026-07-28
//     bug where JS and SQL disagreed and 7 aliases silently stopped resolving.
//   loose — deliberately sloppier (drops HS/High School, folds all punctuation,
//     collapses whitespace). Used ONLY to reconcile names across sources
//     (LaxNumbers class pages vs the WHSBLA export), never against the DB.
const loose = s => String(s || '').toLowerCase().trim()
  .replace(/\b(high school|hs|high)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const norm = loose;

// Dry run assigns synthetic ids so name resolution, game mapping and playoff
// bucketing can all be exercised WITHOUT writing. Without this the dry run
// reports every game as unresolved, which is an artifact, not a finding.
let synthSeq = -1;
const synthId = () => synthSeq--;

const R = { // report accumulator
  teamsCreated: [], teamsMatched: [], aliasesAdded: 0,
  taggedLinked: [], taggedCreated: [], classified: [], unclassified: [], humanApproved: [],
  taggedBlockedByLock: [], conflicts: [], provenanceWritten: 0,
  gamesInserted: 0, gamesUpdated: 0, gamesSkipped: [], unresolved: [],
  dupeKeys: [],
};

async function q(sql, params = []) { const [r] = await db.execute(sql, params); return r; }

async function main() {
  if (db.targetLabel !== 'staging') {
    console.error(`FATAL: resolved target is "${db.targetLabel}". This importer only runs against staging.`);
    process.exit(1);
  }
  console.log(`\n=== import-whsbla ===`);
  console.log(`target: ${db.targetDescription}`);
  console.log(`mode:   ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)'}\n`);

  const P = JSON.parse(fs.readFileSync(`${SP}/whsbla.json`, 'utf8'));
  const CLS = JSON.parse(fs.readFileSync(`${SP}/wa-classes.json`, 'utf8'));

  // class-page name -> division id
  const clsByNorm = new Map();
  for (const d of DIVISIONS) {
    for (const t of (CLS[d.lax] || [])) clsByNorm.set(norm(t.name), d.id);
  }

  // ── existing state ────────────────────────────────────────────────────────
  const prio = new Map((await q('SELECT source, priority FROM game_source_priority'))
    .map(r => [r.source, r.priority]));
  const MY_PRIO = prio.get(SOURCE) ?? 0;
  const existingTeams = await q('SELECT id, slug, name, state FROM teams');
  const existingAliases = await q('SELECT team_id, state, alias_normalized FROM team_aliases');
  const bySlug = new Map(existingTeams.map(t => [t.slug, t]));
  const byId = new Map(existingTeams.map(t => [t.id, t]));
  // resolution index scoped by state (Section F made aliases state-unique)
  // exact index — keys are literally what the DB stores in alias_normalized
  const idxExact = new Map();
  for (const a of existingAliases) idxExact.set(`${a.state}|${a.alias_normalized}`, a.team_id);
  for (const t of existingTeams) {
    idxExact.set(`${t.state}|${normalizeAlias(t.name)}`, t.id);
    idxExact.set(`${t.state}|${normalizeAlias(t.slug)}`, t.id);
  }
  // loose index — cross-source fallback only
  const idxLoose = new Map();
  for (const a of existingAliases) idxLoose.set(`${a.state}|${loose(a.alias_normalized)}`, a.team_id);
  for (const t of existingTeams) {
    idxLoose.set(`${t.state}|${loose(t.name)}`, t.id);
    idxLoose.set(`${t.state}|${loose(t.slug)}`, t.id);
  }
  const resolve = (state, name) =>
    idxExact.get(`${state}|${normalizeAlias(name)}`) ??
    idxLoose.get(`${state}|${loose(name)}`) ?? null;

  // human-approved alias rulings (data, not inference) — see alias-decisions.json
  const DEC = JSON.parse(fs.readFileSync('data/whsbla-2026/alias-decisions.json', 'utf8')).decisions;
  const decByAlias = new Map(DEC.map(d => [d.alias, d]));
  console.log(`human-approved alias decisions loaded: ${DEC.length} (${DEC.map(d => d.alias).join(', ')})`);

  console.log(`existing: ${existingTeams.length} teams (WA=${existingTeams.filter(t => t.state === 'WA').length}), ${existingAliases.length} aliases`);

  // ── 1. divisions ──────────────────────────────────────────────────────────
  for (const d of DIVISIONS) {
    if (COMMIT) {
      await q(`INSERT INTO divisions (id, state, name, is_default, sort_order)
               VALUES (?, 'WA', ?, 0, ?)
               ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order)`,
        [d.id, d.name, d.sort]);
    }
  }
  console.log(`divisions: ${DIVISIONS.length} WA divisions ${COMMIT ? 'upserted' : '(dry run)'}`);

  // ── 2. members -> teams (upsert, reconcile against existing _wa rows) ─────
  const memberTeamId = new Map(); // member name -> team id
  for (const m of P.members) {
    const dec0 = decByAlias.get(m.name);
    let hit = (dec0 && bySlug.get(dec0.resolves_to_slug)?.id) ??
              resolve('WA', m.name) ?? (bySlug.get(m.slug)?.id ?? null);
    if (hit) {
      memberTeamId.set(m.name, hit);
      R.teamsMatched.push({ name: m.name, slug: byId.get(hit)?.slug, id: hit });
    } else if (COMMIT) {
      const res = await q(
        `INSERT INTO teams (slug, name, state) VALUES (?, ?, 'WA')
         ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
        [m.slug, m.name]);
      memberTeamId.set(m.name, res.insertId);
      R.teamsCreated.push({ name: m.name, slug: m.slug, id: res.insertId });
    } else {
      const sid = synthId();
      memberTeamId.set(m.name, sid);
      R.teamsCreated.push({ name: m.name, slug: m.slug, id: sid });
    }
  }

  // aliases for members (name + slug), state-scoped
  if (COMMIT) {
    for (const m of P.members) {
      const id = memberTeamId.get(m.name);
      if (!id) continue;
      for (const a of new Set([m.name, m.slug])) {
        const res = await q(
          `INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
           VALUES (?, 'WA', ?, 'whsbla-2026')`, [id, a]);
        R.aliasesAdded += res.affectedRows;
      }
    }
  }

  // ── 3. provisional classification ─────────────────────────────────────────
  for (const m of P.members) {
    const dec = decByAlias.get(m.name);
    const div = dec ? dec.division_id : clsByNorm.get(loose(m.name));
    if (div) {
      if (dec) R.humanApproved.push({ name: m.name, div, approver: dec.approver });
      R.classified.push({ name: m.name, div });
      if (COMMIT) {
        const id = memberTeamId.get(m.name);
        if (id) {
          await q(
            `INSERT INTO team_seasons (team_id, season, division_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE division_id = VALUES(division_id)`,
            [id, SEASON, div]);
        }
      }
    } else {
      R.unclassified.push(m.name);
    }
  }

  // ── 4. tagged out-of-state opponents ──────────────────────────────────────
  const taggedTeamId = new Map(); // raw -> team id
  for (const t of P.tagged) {
    const tdec = decByAlias.get(t.raw) || decByAlias.get(t.name);
    let hit = (tdec && bySlug.get(tdec.resolves_to_slug)?.id) ?? resolve(t.state, t.name);
    if (hit) {
      taggedTeamId.set(t.raw, hit);
      R.taggedLinked.push({ raw: t.raw, state: t.state, slug: byId.get(hit)?.slug });
    } else {
      const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        + '_' + t.state.toLowerCase();
      if (ROSTER_LOCKED.has(t.state)) {
        // Locked: never fabricate a team. Log for human review instead.
        R.taggedBlockedByLock.push({ raw: t.raw, state: t.state });
        if (COMMIT) {
          await q(`INSERT INTO unresolved_aliases (raw_name, source, state, context, occurrence_count)
                   VALUES (?, ?, ?, ?, 1)
                   ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, context = VALUES(context)`,
            [t.raw, SOURCE, t.state, `roster-locked state ${t.state}; needs an alias-decisions.json ruling`]);
        }
        continue;
      }
      R.taggedCreated.push({ raw: t.raw, state: t.state, slug });
      if (!COMMIT) taggedTeamId.set(t.raw, synthId());
      if (COMMIT) {
        const res = await q(
          `INSERT INTO teams (slug, name, state) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
          [slug, t.name, t.state]);
        taggedTeamId.set(t.raw, res.insertId);
        await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
                 VALUES (?, ?, ?, 'whsbla-2026')`, [res.insertId, t.state, t.name]);
        await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
                 VALUES (?, ?, ?, 'whsbla-2026')`, [res.insertId, t.state, t.raw]);
      }
    }
    // the raw tagged string ("Aloha (OR)") must also resolve, for schedule lookup
    if (COMMIT && taggedTeamId.get(t.raw)) {
      const res = await q(`INSERT IGNORE INTO team_aliases (team_id, state, alias, source)
                           VALUES (?, ?, ?, 'whsbla-2026')`,
        [taggedTeamId.get(t.raw), t.state, t.raw]);
      R.aliasesAdded += res.affectedRows;
    }
  }

  // ── 5. games ──────────────────────────────────────────────────────────────
  const nameToId = new Map();
  for (const [n, id] of memberTeamId) nameToId.set(n, id);
  for (const [n, id] of taggedTeamId) nameToId.set(n, id);

  // launched states with a curated roster — clause (b) of the acceptance policy
  const LAUNCHED = new Set(['OR']);
  const memberNames = new Set(P.members.map(m => m.name));
  const stateOfName = n => {
    const id = nameToId.get(n); return id ? byId.get(id)?.state : null;
  };

  const seenKey = new Map();
  for (const g of P.games) {
    const memberSide = memberNames.has(g.home) || memberNames.has(g.away);
    const launchedSide = LAUNCHED.has(stateOfName(g.home)) || LAUNCHED.has(stateOfName(g.away));
    if (!memberSide && !launchedSide) {
      R.rejectedOutOfScope = R.rejectedOutOfScope || [];
      R.rejectedOutOfScope.push(`${g.date} ${g.away} @ ${g.home} (${g.type})`);
      continue;
    }
    const hid = nameToId.get(g.home), aid = nameToId.get(g.away);
    if (!hid || !aid) {
      if (!hid) R.unresolved.push(g.home);
      if (!aid) R.unresolved.push(g.away);
      R.gamesSkipped.push(g);
      continue;
    }
    const key = `${SEASON}|${hid}|${aid}|${g.date}`;
    if (seenKey.has(key)) { R.dupeKeys.push({ key, ...g }); continue; }
    seenKey.set(key, g);

    const status = (g.home_score !== null && g.away_score !== null) ? 'completed' : 'scheduled';
    // Section F3: type and location are real columns now. Only the free-text
    // notation (Overtime / Forfeit / referee counts) stays in status_note.
    const GTYPE = { Normal: 'league', NL: 'non_league', Playoff: 'playoff',
                    Exhibition: 'exhibition', Practice: 'practice' };
    const gameType = GTYPE[g.type] || 'non_league';
    const note = g.notation ? `note=${g.notation}`.slice(0, 256) : null;
    if (!COMMIT) { R.gamesInserted++; continue; }

    // Does a higher-priority source already own this row? game_source_priority
    // arbitrates: we never overwrite a field an owner holds. We log the
    // disagreement and leave the owner's value standing. Provenance is written
    // either way, so the DB never misreports where a value came from.
    const [[existing]] = [await q(
      `SELECT id, canonical_source, game_datetime, is_conference, is_overtime,
              home_score, away_score, status
       FROM games WHERE season = ? AND home_team_id = ? AND away_team_id = ? AND game_date = ?`,
      [SEASON, hid, aid, g.date])];
    const owner = existing?.canonical_source ?? null;
    const ownerPrio = owner ? (prio.get(owner) ?? 0) : -1;

    let gameId;
    if (existing && ownerPrio > MY_PRIO) {
      // OWNED BY A HIGHER-PRIORITY SOURCE — compare, log, do not touch.
      gameId = existing.id;
      const cmp = [
        ['home_score', existing.home_score, g.home_score],
        ['away_score', existing.away_score, g.away_score],
        ['is_overtime', existing.is_overtime, g.is_overtime],
        ['game_datetime',
          existing.game_datetime ? new Date(existing.game_datetime).toISOString().slice(0, 19) : null,
          g.datetime ? g.datetime.replace(' ', 'T') : null],
      ];
      for (const [field, ov, mv] of cmp) {
        if (ov === null || mv === null) continue;
        if (String(ov) === String(mv)) continue;
        R.conflicts.push({ game_id: gameId, field, owner, owner_value: String(ov), other_value: String(mv) });
        await q(
          `INSERT INTO source_conflicts (game_id, field, owner_source, owner_value, other_source, other_value)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE owner_value = VALUES(owner_value),
             other_value = VALUES(other_value), last_seen_at = NOW()`,
          [gameId, field, owner, String(ov), SOURCE, String(mv)]);
      }
      R.gamesSkippedOwned = (R.gamesSkippedOwned || 0) + 1;
    } else {
      const res = await q(
        `INSERT INTO games (season, home_team_id, away_team_id, game_date, game_datetime,
           is_conference, is_overtime, is_scrimmage, game_type, location,
           home_score, away_score, status, status_note, canonical_source, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           game_datetime = VALUES(game_datetime), is_conference = VALUES(is_conference),
           is_overtime = VALUES(is_overtime), is_scrimmage = VALUES(is_scrimmage),
           game_type = VALUES(game_type), location = VALUES(location),
           home_score = VALUES(home_score), away_score = VALUES(away_score),
           status = VALUES(status), status_note = VALUES(status_note),
           canonical_source = VALUES(canonical_source),
           source_updated_at = NOW(), id = LAST_INSERT_ID(id)`,
        [SEASON, hid, aid, g.date, g.datetime, g.is_league, g.is_overtime, g.is_scrimmage,
         gameType, g.location, g.home_score, g.away_score, status, note, SOURCE]);
      gameId = res.insertId;
      if (res.affectedRows === 1) R.gamesInserted++; else R.gamesUpdated++;
    }

    // Provenance ALWAYS written, whether or not our values were applied.
    await q(
      `INSERT INTO game_source_records
         (game_id, source, source_game_date, home_team_raw, away_team_raw,
          home_score, away_score, is_overtime, is_conference, venue_name_raw, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         source_game_date = VALUES(source_game_date), home_score = VALUES(home_score),
         away_score = VALUES(away_score), is_overtime = VALUES(is_overtime),
         is_conference = VALUES(is_conference), venue_name_raw = VALUES(venue_name_raw),
         scraped_at = NOW()`,
      [gameId, SOURCE, g.date, g.home, g.away, g.home_score, g.away_score,
       g.is_overtime, g.is_league, g.location]);
    R.provenanceWritten++;
  }

  // ── 6. playoffs: bucket the 43 playoff games by provisional classification ─
  const divByName = new Map(R.classified.map(c => [c.name, c.div]));
  const divName = Object.fromEntries(DIVISIONS.map(d => [d.id, d.name]));
  const buckets = {}; const crossDivision = []; const unknownDiv = [];
  for (const g of P.games.filter(x => x.is_playoff)) {
    const dh = divByName.get(g.home), da = divByName.get(g.away);
    if (!dh || !da) { unknownDiv.push(g); continue; }
    if (dh !== da) { crossDivision.push({ ...g, dh, da }); continue; }
    (buckets[dh] = buckets[dh] || []).push(g);
  }
  const lastDate = P.games.filter(x => x.is_playoff).map(g => g.date).sort().pop();
  R.playoffs = {
    total: P.games.filter(x => x.is_playoff).length,
    lastDate,
    crossDivision: crossDivision.length,
    unknownDivision: unknownDiv.length,
    brackets: {},
  };
  console.log(`\n--- PLAYOFF BRACKETS (bucketed by provisional classification) ---`);
  console.log(`  cross-division games (must be 0): ${crossDivision.length}`);
  console.log(`  games whose teams lack a division (must be 0): ${unknownDiv.length}`);
  console.log(`  final date: ${lastDate}`);
  for (const d of DIVISIONS) {
    const gs = buckets[d.id] || [];
    const finals = gs.filter(g => g.date === lastDate);
    let champ = null;
    if (finals.length === 1) {
      const f = finals[0];
      champ = f.home_score > f.away_score ? f.home : f.away;
    }
    R.playoffs.brackets[d.id] = {
      name: d.name, games: gs.length, teams: [...new Set(gs.flatMap(g => [g.home, g.away]))].length,
      dates: [...new Set(gs.map(g => g.date))].sort(),
      finalsOnLastDate: finals.length,
      final: finals.map(f => `${f.away} ${f.away_score} @ ${f.home} ${f.home_score}${f.notation ? ' (' + f.notation + ')' : ''}`),
      champion: champ,
    };
    console.log(`  ${d.id.padEnd(11)} ${String(gs.length).padStart(2)} games, ${String(R.playoffs.brackets[d.id].teams).padStart(2)} teams, finals=${finals.length}  champion=${champ || 'N/A'}`);
    finals.forEach(f => console.log(`      FINAL  ${f.away} ${f.away_score} @ ${f.home} ${f.home_score}${f.notation ? '  (' + f.notation + ')' : ''}  loc=${f.location}`));
  }
  const bucketSum = Object.values(buckets).reduce((n, a) => n + a.length, 0);
  console.log(`  bucketed ${bucketSum}/${R.playoffs.total} playoff games; brackets non-overlapping: ${crossDivision.length === 0}`);

  // PERMANENT ASSERTION — a single-elimination bracket with n teams has exactly
  // n-1 games. A misclassified team breaks the tree, so this catches
  // classification errors that per-bracket counts alone would hide. Keep this in
  // every future playoff import, not just this one.
  const treeFail = [];
  for (const [id, b] of Object.entries(R.playoffs.brackets)) {
    if (b.games !== b.teams - 1) treeFail.push(`${id}: ${b.teams} teams but ${b.games} games (expected ${b.teams - 1})`);
    if (b.finalsOnLastDate !== 1) treeFail.push(`${id}: ${b.finalsOnLastDate} finals on ${lastDate} (expected exactly 1)`);
  }
  R.playoffs.singleEliminationTreeOk = treeFail.length === 0;
  console.log(`  single-elimination tree (n teams => n-1 games, 1 final each): ` +
    (treeFail.length === 0 ? 'PASS' : 'FAIL -> ' + treeFail.join('; ')));
  if (treeFail.length && COMMIT) {
    console.error('  ABORTING: bracket structure is invalid; refusing to commit playoff data.');
    process.exit(1);
  }

  console.log('\n' + JSON.stringify({
    members: P.members.length,
    teamsMatchedExisting: R.teamsMatched.length,
    teamsCreated: R.teamsCreated.length,
    aliasesAdded: R.aliasesAdded,
    classified: R.classified.length,
    unclassified: R.unclassified,
    humanApprovedClassifications: R.humanApproved,
    taggedLinkedToExisting: R.taggedLinked.length,
    taggedCreatedNew: R.taggedCreated.length,
    gamesInserted: R.gamesInserted,
    gamesUpdated: R.gamesUpdated,
    gamesSkipped: R.gamesSkipped.length,
    gamesLeftToHigherPrioritySource: R.gamesSkippedOwned || 0,
    fieldConflictsLogged: R.conflicts.length,
    provenanceRowsWritten: R.provenanceWritten,
    taggedBlockedByRosterLock: R.taggedBlockedByLock,
    rejectedOutOfScope: R.rejectedOutOfScope || [],
    unresolvedNames: [...new Set(R.unresolved)],
    sameDayDuplicateKeys: R.dupeKeys.length,
    playoffs: R.playoffs,
  }, null, 1));

  fs.writeFileSync(`${SP}/import-report.json`, JSON.stringify(R, null, 1));
  console.log(`\nfull detail -> ${SP}/import-report.json`);
  await db.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
