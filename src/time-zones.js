/**
 * The IANA time zone a team plays its home games in.
 *
 * Used by the API's per-game `timeZone` field (the home team's zone), so a client can
 * show a kickoff in local time. The same rules decide how the LaxNumbers import reads a
 * game time (src/laxnumbers-games/time.js on laxnumbers-games-core):
 *   1. data/team-timezones.json, for a team whose zone is not its state's (the Idaho
 *      panhandle and the Spokane schools rostered in Idaho are Pacific);
 *   2. the state registry's timeZone (src/config/states.js);
 *   3. STATE_ZONES below, for opponents' states outside the registry;
 *   4. otherwise null: unknown, and a client falls back to Pacific.
 * IANA names only, never a fixed offset.
 */
const path = require('path');
const { getState } = require('./config/states');

const PACIFIC = 'America/Los_Angeles';

// States and provinces that appear as home teams but are not in the registry. Each is the
// IANA zone for the state's main population; a team elsewhere belongs in the override file.
const STATE_ZONES = {
  CA: 'America/Los_Angeles', BC: 'America/Vancouver', UT: 'America/Denver',
  NM: 'America/Denver', WY: 'America/Denver', CO: 'America/Denver',
  TX: 'America/Chicago', TN: 'America/Chicago', IL: 'America/Chicago',
  FL: 'America/New_York', NY: 'America/New_York', RI: 'America/New_York',
};

const OVERRIDES_FILE = path.join(__dirname, '..', 'data', 'team-timezones.json');

function isValidZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** slug -> zone from the override file. Throws on an unknown zone or a duplicate slug. */
function loadOverrides(file = OVERRIDES_FILE) {
  const doc = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const m = new Map();
  for (const t of doc.teams) {
    if (!isValidZone(t.zone)) throw new Error(`team-timezones.json: "${t.slug}" has unknown zone "${t.zone}"`);
    if (m.has(t.slug)) throw new Error(`team-timezones.json: "${t.slug}" listed twice`);
    m.set(t.slug, t.zone);
  }
  return m;
}

/** The zone a team plays its home games in, or null when we do not know it. */
function teamZone(team, overrides) {
  if (!team) return null;
  if (team.slug && overrides.has(team.slug)) return overrides.get(team.slug);
  if (!team.state) return null;
  return getState(team.state)?.timeZone ?? STATE_ZONES[team.state] ?? null;
}

module.exports = { teamZone, loadOverrides, isValidZone, PACIFIC, STATE_ZONES, OVERRIDES_FILE };
