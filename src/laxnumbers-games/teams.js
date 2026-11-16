/**
 * What the game import remembers between runs: migrations/section-n-laxnumbers-teams.sql.
 *
 * Three decisions live here, as plain functions so they test without a database:
 *
 *   whyFetch   does this team's page need reading this run?
 *                all      a full pass was asked for (the default)
 *                new      no stored row
 *                gp       games-played moved since the stored read
 *                daily    the stored read is from before today's Pacific midnight; a
 *                         score correction or a new fixture does not move gp
 *                null     unchanged: skip the page
 *   identity   a fresh lookup checked against the stored team for that number
 *                agree, or nothing stored      → the fresh result
 *                fresh finds nothing (a rename) → the stored team
 *                fresh REFUSES (ambiguous, foreign-unruled) → the refusal stands
 *                they DISAGREE                  → refused as 'identity-conflict', logged;
 *                                                 never followed silently
 *   pacificMidnightUtc   the cutoff for 'daily', as a UTC DATETIME string
 */
const { todayIn, instantOf, PACIFIC } = require('./time');

const key = (state, nbr) => `${state}|${nbr}`;

/** Why a page must be read, or null to skip it. `stored` is a row from loadStored(). */
function whyFetch(t, stored, { changedOnly, cutoffUtc }) {
  if (!changedOnly) return 'all';
  if (!stored) return 'new';
  if (t.gp == null || stored.gp !== Number(t.gp)) return 'gp';
  if (stored.fetchedAt < cutoffUtc) return 'daily';
  return null;
}

/**
 * `fresh` is a resolveRated() result; `stored` the row for the same feed and number, or
 * undefined. `exists(id)` says whether a team id is still in the roster.
 */
function identity(fresh, stored, exists) {
  if (!stored || !exists(stored.teamId)) return fresh;
  if (fresh.id != null) {
    if (fresh.id === stored.teamId) return fresh;
    return { id: null, reason: 'identity-conflict', storedId: stored.teamId, freshId: fresh.id,
             rowState: fresh.rowState };
  }
  if (fresh.reason === 'unknown') return { id: stored.teamId, via: 'stored', rowState: fresh.rowState };
  return fresh;
}

/** Today's Pacific midnight as a UTC "YYYY-MM-DD HH:MM:SS", comparable with fetched_at. */
function pacificMidnightUtc(now = Date.now()) {
  const ms = instantOf(todayIn(PACIFIC, now), '00:00', PACIFIC);
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * season's rows as Map("ST|nbr" → { teamId, gp, fetchedAt }), or null when the table does
 * not exist yet (a database before section N): the import then runs as it did before it,
 * remembering nothing.
 */
async function loadStored(c, season) {
  try {
    const [rows] = await c.execute(
      `SELECT state, team_nbr, team_id, gp, DATE_FORMAT(fetched_at, '%Y-%m-%d %H:%i:%s') AS fetched_at
         FROM laxnumbers_teams WHERE season = ?`, [season]);
    return new Map(rows.map(r => [key(r.state, r.team_nbr),
      { teamId: r.team_id, gp: r.gp == null ? null : Number(r.gp), fetchedAt: r.fetched_at }]));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}

/** Called inside the state's game transaction, after its games are written. */
async function storeRead(c, season, state, t, teamId) {
  await c.execute(
    `INSERT INTO laxnumbers_teams (season, state, team_nbr, team_id, gp, fetched_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP()) AS n
     ON DUPLICATE KEY UPDATE team_id = n.team_id, gp = n.gp, fetched_at = n.fetched_at`,
    [season, state, Number(t.team_nbr), teamId, t.gp == null ? null : Number(t.gp)]);
}

module.exports = { whyFetch, identity, pacificMidnightUtc, loadStored, storeRead, key };
