// Per-state registry — the single source of truth for which states exist, where
// their data comes from, and what the product can render for each.
//
// WHY A FILE, NOT A TABLE: every value here is code-coupled (source IDs,
// capability flags, division catalogs the iOS app renders offline). A new state
// is a deploy, not a row insert. Per-SEASON data — which division a team is in —
// lives in the DB, in team_seasons.division_id.
//
// NOT env-driven, deliberately: WRITE_MODE went missing from Railway's variables
// on 2026-07-11 and silently reverted dual-write to legacy for two days
// (db/migrate/MIGRATION-STATUS.md). A registry in git cannot drift or go absent.
//
// Division identity follows the architecture plan (decision 2b = C): divisions
// are real rows in the `divisions` table with stable ids and an is_default flag.
// Oregon's single implicit division is 'or_open', is_default = 1 — which is what
// makes the API omit `division` for Oregon and keeps its responses byte-identical.

/** The incumbent. Every state-scoped API parameter defaults to this, so callers
 *  written before multi-state keep working unchanged. */
const DEFAULT_STATE = 'OR';

const STATES = {
  OR: {
    code: 'OR',
    name: 'Oregon',
    enabled: true,

    // Oregon slugs are bare ('jesuit', not 'jesuit_or') and grandfathered: they
    // appear in v2 API paths and in the app's RankingEntry.teamId, so renaming
    // them would break byte-identity. Every state added after Oregon uses a
    // suffix (decision D4 — amended from the plan's original prefix wording).
    slugSuffix: '',

    timeZone: 'America/Los_Angeles',
    laxnumbersId: 3443,

    // Governing body for the context line under a rankings list. NAMED ONLY WHEN
    // ONE LEAGUE GOVERNS EVERY LISTED TEAM — otherwise null, and the app falls
    // back to "<count> programs · <State> high school lacrosse". Naming a league
    // that covers only part of a list is the KingCo error.
    leagueName: 'OHSLA',

    // Mirrors the `divisions` table. Oregon is the degenerate single-division
    // case; isDefault suppresses all division affordances in the UI and the API.
    divisions: [
      { id: 'or_open', name: 'All', isDefault: true, sortOrder: 0 },
    ],

    // Region catalog deliberately null — Oregon's regions are undefined and
    // Team.area is city-level, not a clean source. teams.region stays NULL.
    regions: null,

    capabilities: { hasRankings: true, hasSchedules: true, hasPlayoffs: true },

    scheduleSource: {
      kind:  'sportability',
      host:  'https://ohsla.net',
      group: 'BHS',   // Sportability league segment — OHSLA "Boys High School"
      lgId:  null,    // OHSLA's ASP pages expose no LgID parameter
      label: 'OHSLA',
    },

    playoffs: null,   // PlayoffFormat extraction is a later phase
  },

  WA: {
    code: 'WA',
    name: 'Washington',
    // enabled gates the SCRAPER ONLY, and its single consumer is
    // enabledStates('hasRankings') in cron.js and index.js — so this flag turns on
    // WA RANKINGS SCRAPING and nothing else. Washington's GAMES are export-based
    // (the WHSBLA xlsx), not scraped, and no code path tries to scrape them.
    //
    // true since stage (c) / window #3: the one-off backfill seeds the first WA
    // snapshot, and from then on the 2-hourly cron keeps it current the same way it
    // does Oregon's. Leaving it false would have frozen WA rankings at whatever the
    // backfill captured, which is the "silently stale" failure this project keeps
    // finding rather than a missing feature.
    //
    // It never meant the state was hidden: /api/v2/states lists every registered
    // state regardless.
    enabled: true,
    slugSuffix: '_wa',
    timeZone: 'America/Los_Angeles',
    laxnumbersId: 3580,
    leagueName: 'WHSBLA',
    // Mirrors the divisions table. WHSBLA scrapped 1A; these four are exact.
    divisions: [
      { id: 'wa_4a',      name: '4A',      isDefault: false, sortOrder: 0 },
      { id: 'wa_3a',      name: '3A',      isDefault: false, sortOrder: 1 },
      { id: 'wa_2a',      name: '2A',      isDefault: false, sortOrder: 2 },
      { id: 'wa_private', name: 'PV/Open', isDefault: false, sortOrder: 3 },
    ],
    regions: null,
    capabilities: { hasRankings: true, hasSchedules: true, hasPlayoffs: true },
    scheduleSource: { kind: 'export', host: null, group: null, lgId: '50652', label: 'WHSBLA' },
    playoffs: null,
  },

  // ── rankings-only states ──────────────────────────────────────────────────
  // Division structure is genuinely unknown for these four. Each carries the
  // degenerate single default division, exactly like Oregon, so the app's
  // "isDefault => render no chips" rule needs no special case. Do NOT invent
  // classifications here.
  //
  // NOTE: the matching `divisions` rows do not exist in the database yet — they
  // are created when a state is seeded. This endpoint reads the registry, so the
  // id is advertised before the row exists. team_seasons.division_id has an FK,
  // so seeding must create the row first.
  AZ: {
    code: 'AZ', name: 'Arizona', enabled: false, slugSuffix: '_az',
    timeZone: 'America/Phoenix',        // no DST — Arizona does not observe it
    laxnumbersId: 3013,
    leagueName: 'Arizona Lacrosse League',   // single official league for AZ boys
    divisions: [{ id: 'az_open', name: 'All', isDefault: true, sortOrder: 0 }],
    regions: null,
    capabilities: { hasRankings: true, hasSchedules: false, hasPlayoffs: false },
    scheduleSource: null, playoffs: null,
  },
  ID: {
    code: 'ID', name: 'Idaho', enabled: false, slugSuffix: '_id',
    timeZone: 'America/Boise',
    laxnumbersId: 3146,
    // NULL deliberately. SWILA covers the Treasure Valley only; the LaxNumbers
    // Idaho feed spans multiple leagues (North Idaho and others). Naming SWILA
    // over the whole list is the KingCo error. The feed cannot even identify
    // SWILA membership — its `suffix` field is a division-leader badge and reads
    // SWILA exactly once across 24 Idaho teams.
    leagueName: null,
    divisions: [{ id: 'id_open', name: 'All', isDefault: true, sortOrder: 0 }],
    regions: null,
    capabilities: { hasRankings: true, hasSchedules: false, hasPlayoffs: false },
    scheduleSource: null, playoffs: null,
  },
  MT: {
    code: 'MT', name: 'Montana', enabled: false, slugSuffix: '_mt',
    timeZone: 'America/Denver',
    laxnumbersId: 3300,
    leagueName: 'Montana High School Lacrosse League',
    divisions: [{ id: 'mt_open', name: 'All', isDefault: true, sortOrder: 0 }],
    regions: null,
    capabilities: { hasRankings: true, hasSchedules: false, hasPlayoffs: false },
    scheduleSource: null, playoffs: null,
  },
  NV: {
    code: 'NV', name: 'Nevada', enabled: false, slugSuffix: '_nv',
    timeZone: 'America/Los_Angeles',
    laxnumbersId: 3341,
    // NULL deliberately — the state splits between the High Sierra Lacrosse
    // League (Reno/Tahoe) and the Las Vegas Lacrosse Alliance, and the feed
    // mixes both.
    leagueName: null,
    divisions: [{ id: 'nv_open', name: 'All', isDefault: true, sortOrder: 0 }],
    regions: null,
    capabilities: { hasRankings: true, hasSchedules: false, hasPlayoffs: false },
    scheduleSource: null, playoffs: null,
  },
};

// ── accessors ────────────────────────────────────────────────────────────────

function getState(code) {
  return STATES[String(code || '').toUpperCase()] || null;
}

function isValidState(code) {
  return getState(code) !== null;
}

/** Registered states, enabled or not. Registry order. */
function listStates() {
  return Object.values(STATES);
}

/** States that are switched on AND support `capability`. */
function enabledStates(capability) {
  return listStates().filter(s =>
    s.enabled && (capability ? s.capabilities[capability] === true : true));
}

function divisionsFor(code) {
  const s = getState(code);
  return s ? s.divisions : [];
}

/** The division a single-division state implicitly uses, or null. */
function defaultDivision(code) {
  return divisionsFor(code).find(d => d.isDefault) || null;
}

module.exports = {
  DEFAULT_STATE, STATES,
  getState, isValidState, listStates, enabledStates, divisionsFor, defaultDivision,
};
