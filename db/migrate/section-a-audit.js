// Runbook Section A (A2–A13) — read-only pre-flight audit, adapted to actual schema:
//   runbook `games`    -> team_schedules (game_date, game_time)
//   runbook `rankings` -> laxnumbers_rankings (rating/agd/sched) + laxpower_rankings (consensus)
//   runbook `teams`    -> no table; canonical team IDs from src/scrapers/ohsla.js SCHOOLS
// Every query here is a SELECT / SHOW. Nothing writes to production.
// Run from varsitylax-scraper/:  node db/migrate/section-a-audit.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CANONICAL_TEAMS = [
  'aloha_southridge','beaverton','bend_caldera','burns','canby','central_catholic',
  'century','corvallis','forest_grove','glencoe','grant','hillsboro','hood_river',
  'ida_b_wells','jesuit','lake_oswego','lakeridge','liberty','lincoln','marist',
  'mountainside','mt_view','nelson','newberg','oes','oregon_city','roseburg',
  'sheldon','sherwood','south_eugene','sprague','summit','sunset','thurston',
  'tigard','tualatin','west_albany','west_linn','west_salem','westview','wilsonville',
];

const OUT_DIR = path.join(__dirname, 'out');
const report = [];
const raw = {};
let conn;

function md(s) { report.push(s); }
function table(rows, limit = 50) {
  if (!rows || rows.length === 0) return '_(no rows)_\n';
  const cols = Object.keys(rows[0]);
  let s = '| ' + cols.join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n';
  for (const r of rows.slice(0, limit)) {
    s += '| ' + cols.map(c => String(r[c] === null ? 'NULL' : r[c]).replace(/\|/g, '\\|')).join(' | ') + ' |\n';
  }
  if (rows.length > limit) s += `\n_(${rows.length - limit} more rows — see JSON)_\n`;
  return s;
}
async function q(label, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  raw[label] = rows;
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });

  md(`# Section A Audit Report\n\nGenerated: ${new Date().toISOString()}\nDatabase: ${process.env.DB_NAME} @ ${process.env.DB_HOST}\n`);

  // ── A2: capability checks ──
  md('## A2. MySQL capability checks\n');
  const ver = await q('a2_version', 'SELECT VERSION() AS mysql_version');
  const rowFmt = await q('a2_rowformat', "SHOW VARIABLES LIKE 'innodb_default_row_format'");
  const largePrefix = await q('a2_largeprefix', "SHOW VARIABLES LIKE 'innodb_large_prefix'");
  const fileFmt = await q('a2_fileformat', "SHOW VARIABLES LIKE 'innodb_file_format'");
  const charset = await q('a2_charset', "SHOW CHARACTER SET LIKE 'utf8mb4'");
  const v = ver[0].mysql_version;
  md(`- VERSION(): **${v}**`);
  md(`- innodb_default_row_format: **${rowFmt[0] ? rowFmt[0].Value : '(not found)'}**`);
  md(`- innodb_large_prefix: **${largePrefix.length ? largePrefix[0].Value : '(empty — expected on 8.0+)'}**`);
  md(`- innodb_file_format: **${fileFmt.length ? fileFmt[0].Value : '(empty — expected on 8.0+)'}**`);
  md(`- utf8mb4 available: **${charset.length > 0}**`);
  const a2go = v >= '8.0' && (rowFmt[0] || {}).Value === 'dynamic' && charset.length > 0
    && (largePrefix.length === 0 || largePrefix[0].Value === 'ON');
  md(`\n**A2: ${a2go ? 'GO' : 'NO-GO / REVIEW'}**\n`);

  // ── A3: schema inventory ──
  md('## A3. Schema inventory\n');
  const tbls = await q('a3_tables', `SELECT table_name, engine, row_format, table_rows, table_collation
    FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`);
  md('### Tables\n\n' + table(tbls));
  const cols = await q('a3_columns', `SELECT table_name, column_name, ordinal_position, column_type,
    is_nullable, column_default, column_key, extra
    FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`);
  md('### Columns\n\n' + table(cols, 100));
  const idx = await q('a3_indexes', `SELECT table_name, index_name, non_unique, seq_in_index, column_name
    FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index`);
  md('### Indexes\n\n' + table(idx, 60));
  const fks = await q('a3_fks', `SELECT kcu.table_name, kcu.constraint_name, kcu.column_name,
    kcu.referenced_table_name, kcu.referenced_column_name, rc.delete_rule, rc.update_rule
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema
    WHERE kcu.table_schema = DATABASE() ORDER BY kcu.table_name, kcu.constraint_name`);
  md('### Foreign keys\n\n' + table(fks));

  const tableNames = tbls.map(t => t.table_name || t.TABLE_NAME);
  const hasTeams = tableNames.includes('teams');
  md(`\nNote: \`teams\` table present: **${hasTeams}** (canonical IDs live in scraper code if false)\n`);

  // ── A4: baseline row counts ──
  md('## A4. Baseline row counts\n');
  const counts = [];
  for (const t of tableNames) {
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    counts.push({ tbl: t, row_count: c });
  }
  raw.a4_counts = counts;
  md(table(counts));
  md(`**A4: ${counts.every(c => c.row_count > 0) ? 'GO — all non-zero' : 'REVIEW — zero-row table(s) present'}**\n`);

  // ── A5: team_id normalization audit ──
  md('## A5. team_id normalization audit (team_schedules)\n');
  const a5 = await q('a5_norm', `SELECT team_id AS raw_value, LOWER(TRIM(team_id)) AS normalized,
    CHAR_LENGTH(team_id) AS raw_len,
    CASE WHEN BINARY team_id != LOWER(TRIM(team_id)) THEN 'NEEDS_NORM' ELSE 'ok' END AS status,
    COUNT(*) AS game_rows
    FROM team_schedules GROUP BY team_id ORDER BY status DESC, team_id`);
  md(table(a5, 60));
  const needsNorm = a5.filter(r => r.status === 'NEEDS_NORM');
  const maxLen = Math.max(...a5.map(r => r.raw_len));
  md(`- NEEDS_NORM rows: **${needsNorm.length}**, max length: **${maxLen}** (must be ≤ 64)`);
  md(`\n**A5: ${needsNorm.length === 0 && maxLen <= 64 ? 'GO' : 'NO-GO'}**\n`);

  // ── A6: team_id vs canonical list ──
  md('## A6. team_id resolution vs canonical scraper list\n');
  const unmatched = a5.filter(r => !CANONICAL_TEAMS.includes(r.normalized));
  const missing = CANONICAL_TEAMS.filter(t => !a5.some(r => r.normalized === t));
  raw.a6 = { unmatched, missing };
  md(`- Distinct team_ids in games: **${a5.length}** (canonical list: ${CANONICAL_TEAMS.length})`);
  md(`- team_ids NOT in canonical list: **${unmatched.length}**${unmatched.length ? '\n\n' + table(unmatched) : ''}`);
  md(`- Canonical teams with NO games: **${missing.length}**${missing.length ? ' — ' + missing.join(', ') : ''}`);
  md(`\n**A6: ${unmatched.length === 0 ? 'GO' : 'NO-GO — classify each unmatched id'}**\n`);

  // ── A7: opponent resolution ──
  md('## A7. Opponent string resolution\n');
  const opps = await q('a7_opponents', `SELECT opponent AS raw_opponent,
    LOWER(TRIM(opponent)) AS normalized, COUNT(*) AS occurrences
    FROM team_schedules GROUP BY opponent ORDER BY occurrences DESC`);
  const slugify = s => s.toLowerCase().trim().replace(/[.\/&']/g, ' ').replace(/\s+/g, '_').replace(/_+/g, '_');
  const classified = opps.map(o => {
    const slug = slugify(o.raw_opponent);
    const hit = CANONICAL_TEAMS.includes(slug) ? slug
      : CANONICAL_TEAMS.find(t => t === slug.replace(/^the_/, '')) || null;
    return { ...o, guessed_slug: slug, resolution: hit ? 'resolved' : 'UNRESOLVED', resolved_to: hit };
  });
  raw.a7 = classified;
  const unresolved = classified.filter(c => c.resolution === 'UNRESOLVED');
  md(`- Distinct opponent strings: **${classified.length}**, auto-resolved: **${classified.length - unresolved.length}**, UNRESOLVED: **${unresolved.length}**\n`);
  md('### UNRESOLVED opponents (need manual classification: OR alias vs out-of-state vs unknown)\n\n' + table(unresolved, 80));
  md(`\n**A7: ${unresolved.length === 0 ? 'GO' : 'MANUAL CLASSIFICATION REQUIRED — see list above'}**\n`);

  // ── A8: date column ──
  md('## A8. game_date analysis\n');
  const dateType = await q('a8_type', `SELECT column_type, is_nullable FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'team_schedules' AND column_name = 'game_date'`);
  const [nullDates] = await q('a8_nulls', `SELECT COUNT(*) AS null_dates FROM team_schedules WHERE game_date IS NULL`);
  const [zeroDates] = await q('a8_zero', `SELECT COUNT(*) AS zero_or_invalid FROM team_schedules WHERE YEAR(game_date) = 0 OR game_date IS NULL`);
  const prefixes = await q('a8_prefix', `SELECT DISTINCT LEFT(CAST(game_date AS CHAR), 10) AS date_prefix, COUNT(*) AS cnt
    FROM team_schedules GROUP BY LEFT(CAST(game_date AS CHAR), 10) ORDER BY cnt DESC LIMIT 20`);
  const [range] = await q('a8_range', `SELECT MIN(game_date) AS earliest, MAX(game_date) AS latest FROM team_schedules`);
  md(`- Type: **${dateType[0].column_type || dateType[0].COLUMN_TYPE}**, nulls: **${nullDates.null_dates}**, zero/invalid: **${zeroDates.zero_or_invalid}**`);
  md(`- Range: **${range.earliest}** → **${range.latest}**`);
  md('\n' + table(prefixes));
  md(`\n**A8: ${nullDates.null_dates === 0 && zeroDates.zero_or_invalid === 0 ? 'GO' : 'NO-GO'}**\n`);

  // ── A9: time column ──
  md('## A9. game_time analysis\n');
  const times = await q('a9_times', `SELECT game_time AS stored_value, CHAR_LENGTH(game_time) AS len, COUNT(*) AS occurrences
    FROM team_schedules GROUP BY game_time ORDER BY occurrences DESC`);
  const [nullTimes] = await q('a9_nulls', `SELECT COUNT(*) AS null_times FROM team_schedules WHERE game_time IS NULL`);
  const maxTimeLen = Math.max(0, ...times.filter(t => t.len !== null).map(t => t.len));
  md(`- Distinct values: **${times.length}**, nulls: **${nullTimes.null_times}**, max length: **${maxTimeLen}** (runbook DDL expects ≤ 8)\n`);
  md(table(times, 30));
  md(`\n**A9: ${maxTimeLen <= 8 ? 'GO' : 'REVIEW — widen game_time VARCHAR in Phase 1 DDL before B1'}**\n`);

  // ── A10: duplicates ──
  md('## A10. Duplicate detection\n');
  const intraDupes = await q('a10_intra', `SELECT team_id, opponent, game_date, COUNT(*) AS cnt
    FROM team_schedules GROUP BY team_id, opponent, game_date HAVING cnt > 1 ORDER BY cnt DESC`);
  md('### Intra-team duplicates (same team_id + opponent + date) — must be zero\n\n' + table(intraDupes));
  const [singles] = await q('a10_singles', `SELECT COUNT(*) AS n FROM (
    SELECT 1 FROM team_schedules GROUP BY
      LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
      GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))), game_date
    HAVING COUNT(*) = 1) x`);
  const [doubles] = await q('a10_doubles', `SELECT COUNT(*) AS n FROM (
    SELECT 1 FROM team_schedules GROUP BY
      LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
      GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))), game_date
    HAVING COUNT(*) = 2) x`);
  const [more] = await q('a10_more', `SELECT COUNT(*) AS n FROM (
    SELECT 1 FROM team_schedules GROUP BY
      LEAST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))),
      GREATEST(LOWER(TRIM(team_id)), LOWER(TRIM(opponent))), game_date
    HAVING COUNT(*) > 2) x`);
  const gamesCount = counts.find(c => c.tbl === 'team_schedules').row_count;
  md(`- Single-appearance matchups: **${singles.n}**, double: **${doubles.n}**, >2 (anomaly): **${more.n}**`);
  md(`- Arithmetic: ${singles.n} + 2×${doubles.n} = **${singles.n + 2 * doubles.n}** vs A4 games count **${gamesCount}**`);
  md('- Caveat: pairing uses literal strings; slug-vs-display-name means most OR-vs-OR games appear "single" here. Semantic dedup happens in D1 via team_aliases — this check mainly screens for intra-team dupes and >2 anomalies.');
  md(`\n**A10: ${intraDupes.length === 0 && more.n === 0 ? 'GO' : 'NO-GO'}**\n`);

  // ── A11: rating column types ──
  md('## A11. Rating column types\n');
  const ratingCols = await q('a11_types', `SELECT table_name, column_name, column_type, is_nullable, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = DATABASE()
    AND ((table_name = 'laxnumbers_rankings' AND column_name IN ('rating','agd','sched'))
      OR (table_name = 'laxpower_rankings' AND column_name = 'consensus'))
    ORDER BY table_name, column_name`);
  md(table(ratingCols));
  md(`\n**A11: ${ratingCols.length === 4 ? 'GO — 4 columns found' : 'REVIEW — expected 4 rating columns, found ' + ratingCols.length}**\n`);

  // ── A12: FLOAT drift ──
  md('## A12. Precision drift check\n');
  const [driftRating] = await q('a12_rating', `SELECT COUNT(*) AS n FROM laxnumbers_rankings
    WHERE ABS(rating - CAST(rating AS DECIMAL(8,2))) > 0.005`);
  const [driftAgd] = await q('a12_agd', `SELECT COUNT(*) AS n FROM laxnumbers_rankings
    WHERE agd IS NOT NULL AND ABS(agd - CAST(agd AS DECIMAL(8,2))) > 0.005`);
  const [driftCons] = await q('a12_consensus', `SELECT COUNT(*) AS n FROM laxpower_rankings
    WHERE consensus IS NOT NULL AND ABS(consensus - CAST(consensus AS DECIMAL(8,2))) > 0.005`);
  const sample = await q('a12_sample', `SELECT team_name, rating, CAST(rating AS DECIMAL(8,2)) AS rating_decimal,
    rating - CAST(rating AS DECIMAL(8,2)) AS precision_drift
    FROM laxnumbers_rankings ORDER BY rank_position LIMIT 5`);
  md(table(sample));
  md(`- Drifted beyond ±0.005 — rating: **${driftRating.n}**, agd: **${driftAgd.n}**, consensus: **${driftCons.n}**`);
  md('- Note: these round to 2dp; schema declares DECIMAL(8,3) so a value like 5.125 "drifts" 0.005 legitimately. D4 CAST strategy applies regardless.');
  md(`\n**A12: GO (drift recorded)**\n`);

  // ── A13: final snapshot ──
  md('## A13. Final row-count snapshot (must match A4)\n');
  const counts2 = [];
  for (const t of tableNames) {
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    counts2.push({ tbl: t, a4: counts.find(x => x.tbl === t).row_count, a13: c, match: c === counts.find(x => x.tbl === t).row_count ? 'ok' : 'CHANGED' });
  }
  raw.a13 = counts2;
  md(table(counts2));
  md(`\n**A13: ${counts2.every(c => c.match === 'ok') ? 'GO — no data changed during audit' : 'REVIEW — counts changed (live scraper run during audit?)'}**\n`);

  await conn.end();
  fs.writeFileSync(path.join(OUT_DIR, 'section-a-report.md'), report.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'section-a-raw.json'), JSON.stringify(raw, null, 2));
  console.log('Report written to db/migrate/out/section-a-report.md (+ raw JSON)');
}

main().catch(e => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
