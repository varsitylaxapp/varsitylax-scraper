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
