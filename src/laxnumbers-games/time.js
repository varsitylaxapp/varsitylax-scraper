/**
 * Game times for the LaxNumbers import.
 *
 * LaxNumbers lists a 24-hour "HH:MM" per game (blank when unknown) and no zone. We read
 * it in the HOME team's zone (ruled 2026-11-14) and store it the way every other source
 * does: as Pacific wall-clock in games.game_datetime. game_date stays the date LaxNumbers
 * lists, so the API's day grouping (dateKey, from game_date) is the local day.
 *
 * Zones come from IANA rules through Intl — never a hard-coded offset or DST date:
 *   1. data/team-timezones.json, for a team whose zone is not its state's (the Idaho
 *      panhandle and the Spokane schools rostered in Idaho are Pacific);
 *   2. the state registry's timeZone (src/config/states.js);
 *   3. STATE_ZONES below, for opponents' states outside the registry;
 *   4. otherwise unknown: the time is not stored, and the run counts it.
 */
const path = require('path');
const { getState } = require('../config/states');

const PACIFIC = 'America/Los_Angeles';

// States and provinces that appear as home teams but are not in the registry. Each is the
// IANA zone for the state's main population; a team elsewhere belongs in the override file.
const STATE_ZONES = {
  CA: 'America/Los_Angeles', BC: 'America/Vancouver', UT: 'America/Denver',
  NM: 'America/Denver', WY: 'America/Denver', CO: 'America/Denver',
  TX: 'America/Chicago', TN: 'America/Chicago', IL: 'America/Chicago',
  FL: 'America/New_York', NY: 'America/New_York', RI: 'America/New_York',
};

function loadOverrides(file = path.join(__dirname, '..', '..', 'data', 'team-timezones.json')) {
  const doc = require(file);
  const m = new Map();
  for (const t of doc.teams) {
    if (!isValidZone(t.zone)) throw new Error(`team-timezones.json: "${t.slug}" has unknown zone "${t.zone}"`);
    m.set(t.slug, t.zone);
  }
  return m;
}

function isValidZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** The zone a team plays its home games in, or null when we do not know it. */
function teamZone(team, overrides) {
  if (!team) return null;
  if (overrides.has(team.slug)) return overrides.get(team.slug);
  if (!team.state) return null;
  return getState(team.state)?.timeZone ?? STATE_ZONES[team.state] ?? null;
}

// Wall-clock fields of an instant in a zone, from Intl.
function wallParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const asUtc = w => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/**
 * The instant at which a zone's clocks read the given wall time, or null when no instant
 * does (the spring-forward gap). Two passes cover a DST change between guess and answer.
 */
function instantOf(date, time, zone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi, 0);
  let t = want;
  for (let i = 0; i < 2; i++) t = want - (asUtc(wallParts(t, zone)) - t);
  return asUtc(wallParts(t, zone)) === want ? t : null;
}

const pad = n => String(n).padStart(2, '0');
const fmt = w => `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;

/**
 * LaxNumbers' date + "HH:MM" in `zone`, as a Pacific wall-clock DATETIME string, or null.
 * `why` says which of: no time listed, no zone known, unreadable time, nonexistent time.
 */
function toPacific(date, time, zone) {
  if (!time) return { value: null, why: 'no-time' };
  if (!/^\d{1,2}:\d{2}$/.test(time)) return { value: null, why: 'unreadable' };
  if (!zone) return { value: null, why: 'no-zone' };
  const t = instantOf(date, time, zone);
  if (t === null) return { value: null, why: 'nonexistent' };
  return { value: fmt(wallParts(t, PACIFIC)), why: null };
}

/** Today's date in a zone, "YYYY-MM-DD". */
function todayIn(zone, now = Date.now()) {
  const w = wallParts(now, zone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

module.exports = { toPacific, teamZone, loadOverrides, todayIn, instantOf, isValidZone, PACIFIC, STATE_ZONES };
