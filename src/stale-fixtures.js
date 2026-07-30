/**
 * The stale-fixture rule, shared by every ingestion path.
 *
 * A game with no scores, still `scheduled`, more than STALE_AFTER_DAYS past its date
 * is not a real fixture. It gets `status = 'stale'`.
 *
 * WHY THIS LIVES HERE rather than in one scraper. OHSLA never retires a fixture —
 * moved games get a new row and the old one stands; cancelled games stand forever —
 * and there is no reason to believe WHSBLA's Sportability export behaves better.
 * March 2027 needs this for both sources with live users watching, so the rule is
 * one function that every path calls rather than a habit each path might forget.
 *
 * NOT A PRUNE. Prune asks "has the source dropped this row" and for an additive-only
 * source the answer is always no. This asks a question the source cannot answer:
 * "has enough time passed that an unscored fixture must be fiction?"
 *
 * PRACTICE IS EXEMPT. A listed, never-scored practice is a true fact — WHSBLA's
 * export lists practices and nobody scores them. Exhibitions are NOT exempt: an
 * unscored exhibition 14 days past is as dead as any other fixture.
 *
 * `stale_exemptions` is the escape hatch for a real fixture being wrongly aged out.
 * It starts empty and should stay that way.
 */
const STALE_AFTER_DAYS = Number(process.env.STALE_AFTER_DAYS || 14);

/** Games exempt from ageing regardless of date. */
const EXEMPT_GAME_TYPES = ['practice'];

/**
 * Mark newly-stale fixtures for a season.
 *
 * @param {object} db      promise-mode pool or connection
 * @param {number} season
 * @param {object} [opts]
 * @param {string} [opts.source]  limit to one canonical_source; omit for all
 * @param {boolean} [opts.dryRun] report without writing
 * @returns {Promise<{marked:number, rows:Array}>}
 */
async function markStaleFixtures(db, season, opts = {}) {
  const { source, dryRun = false } = opts;
  const params = [season, STALE_AFTER_DAYS];
  let sourceClause = '';
  if (source) { sourceClause = 'AND g.canonical_source = ?'; params.push(source); }

  const [rows] = await db.execute(
    `SELECT g.id, DATE_FORMAT(g.game_date,'%Y-%m-%d') d, g.game_type, g.canonical_source src,
            ht.slug home, at2.slug away
       FROM games g
       JOIN teams ht  ON ht.id  = g.home_team_id
       JOIN teams at2 ON at2.id = g.away_team_id
      WHERE g.season = ?
        AND g.status = 'scheduled'
        AND g.home_score IS NULL AND g.away_score IS NULL
        AND g.game_date < CURDATE() - INTERVAL ? DAY
        AND g.game_type NOT IN (${EXEMPT_GAME_TYPES.map(() => '?').join(',')})
        ${sourceClause}
        AND NOT EXISTS (
          SELECT 1 FROM stale_exemptions e
           WHERE e.season = g.season
             AND e.team_lo = LEAST(g.home_team_id, g.away_team_id)
             AND e.team_hi = GREATEST(g.home_team_id, g.away_team_id)
             AND e.game_date = g.game_date)
      ORDER BY g.game_date, g.id`,
    // EXEMPT types are spliced before the optional source param, matching the SQL.
    [season, STALE_AFTER_DAYS, ...EXEMPT_GAME_TYPES, ...(source ? [source] : [])]);

  if (!rows.length || dryRun) return { marked: 0, rows };

  const [r] = await db.query(
    `UPDATE games SET status = 'stale' WHERE id IN (?)`, [rows.map(x => x.id)]);
  return { marked: r.affectedRows, rows };
}

module.exports = { markStaleFixtures, STALE_AFTER_DAYS, EXEMPT_GAME_TYPES };
