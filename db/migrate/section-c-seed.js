// Runbook Section C — reference data seeding, adapted to actual production state.
//
// ADAPTATIONS vs runbook (approved during execution):
//  - C3: full 31-team out-of-state list generated from a7-classification.json
//    (runbook shipped only the borah example + template). Slugs carry state
//    suffixes (borah_id, mountain_view_wa) to avoid any collision with OR slugs.
//  - C8: borah spot-tests use actual raw string 'Borah HS, ID' (not MockData's
//    'Borah HS (ID)', which never appears in production data).
//  - C8.5: old table is team_schedules (not games_v1 — B1 rename was skipped as
//    unnecessary). 'Team Place Holder' (9 scoreless TBD rows, verified 2026-07-10)
//    is logged to unresolved_aliases and excluded from the zero-unresolved gate.
//  - C9: `AS rows` -> `AS row_count` (reserved word in MySQL 8.0).
//
// All inserts are INSERT IGNORE (idempotent) except C7, which is guarded per runbook.
// Usage (from varsitylax-scraper/):  node db/migrate/section-c-seed.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const A7 = JSON.parse(fs.readFileSync(path.join(__dirname, 'a7-classification.json'), 'utf8'));

// ── C1 venues (verbatim from runbook — 41 rows) ──
const VENUES = [
  ['OES','Portland'],['Hood River HS','Hood River'],['Lincoln HS','Portland'],
  ['Grant HS','Portland'],['Central Catholic HS','Portland'],['Ida B Wells-Barnett HS','Portland'],
  ['Mt. View HS','Bend'],['Caldera HS','Bend'],['Burns HS','Burns'],['Summit HS','Bend'],
  ['Aloha HS','Beaverton'],['Beaverton HS','Beaverton'],['Jesuit HS','Portland'],
  ['Mountainside HS','Beaverton'],['Sunset HS','Beaverton'],['Westview HS','Beaverton'],
  ['West Albany HS','Albany'],['West Salem HS','Salem'],['Crescent Valley HS','Corvallis'],
  ['Sprague HS','Salem'],['Newberg HS','Newberg'],['Sherwood HS','Sherwood'],
  ['Tigard HS','Tigard'],['Tualatin HS','Tualatin'],['Wilsonville HS','Wilsonville'],
  ['Century HS','Hillsboro'],['Forest Grove HS','Forest Grove'],['Glencoe HS','Hillsboro'],
  ['Hillsboro HS','Hillsboro'],['Liberty HS','Hillsboro'],['Roseburg HS','Roseburg'],
  ['South Eugene HS','Eugene'],['Marist HS','Eugene'],['Sheldon HS','Eugene'],
  ['Thurston HS','Springfield'],['Canby HS','Canby'],['Lakeridge HS','Lake Oswego'],
  ['Clackamas HS','Clackamas'],['Oregon City HS','Oregon City'],['West Linn HS','West Linn'],
  ['Lake Oswego HS','Lake Oswego'],
];

// ── C2 Oregon teams (verbatim — 41 rows) ──
const OR_TEAMS = [
  ['oes','Oregon Episcopal','Aardvarks','Portland'],
  ['hood_river','Hood River','Eagles','Hood River'],
  ['lincoln','Lincoln','Cardinals','Portland'],
  ['grant','Grant/Central Eastside','Generals','Portland'],
  ['central_catholic','Central Catholic','Rams','Portland'],
  ['ida_b_wells','Ida B Wells','Ducks','Portland'],
  ['mt_view','Mountain View','Cougars','Bend'],
  ['bend_caldera','Bend/Caldera','Lava Bears','Bend'],
  ['burns','Burns','Hilanders','Burns'],
  ['summit','Summit','Storm','Bend'],
  ['aloha_southridge','Aloha/Southridge','Warriors','Beaverton'],
  ['beaverton','Beaverton','Beavers','Beaverton'],
  ['jesuit','Jesuit Portland','Crusaders','Portland'],
  ['mountainside','Mountainside','Mavericks','Beaverton'],
  ['sunset','Sunset','Apollos','Beaverton'],
  ['westview','Westview','Wildcats','Beaverton'],
  ['west_albany','West Albany','Bulldogs','Albany'],
  ['west_salem','West Salem/McNary','Titans','Salem'],
  ['corvallis','Corvallis/Crescent Valley','Eagles','Corvallis'],
  ['sprague','Sprague/South Salem','Olympians','Salem'],
  ['newberg','Newberg','Tigers','Newberg'],
  ['sherwood','Sherwood','Bowmen','Sherwood'],
  ['tigard','Tigard','Tigers','Tigard'],
  ['tualatin','Tualatin','Timberwolves','Tualatin'],
  ['wilsonville','Wilsonville','Wildcats','Wilsonville'],
  ['century','Century','Jaguars','Hillsboro'],
  ['forest_grove','Forest Grove','Vikings','Forest Grove'],
  ['glencoe','Glencoe','Crimson Tide','Hillsboro'],
  ['hillsboro','Hillsboro','Spartans','Hillsboro'],
  ['liberty','Liberty','Falcons','Hillsboro'],
  ['roseburg','Roseburg','Indians','Roseburg'],
  ['south_eugene','South Eugene','Axemen','Eugene'],
  ['marist','Marist','Spartans','Eugene'],
  ['sheldon','Sheldon','Irish','Eugene'],
  ['thurston','Thurston','Colts','Springfield'],
  ['canby','Canby','Cougars','Canby'],
  ['lakeridge','Lakeridge','Pacers','Lake Oswego'],
  ['nelson','Clackamas/Nelson','Cavaliers','Clackamas'],
  ['oregon_city','Oregon City','Pioneers','Oregon City'],
  ['west_linn','West Linn','Lions','West Linn'],
  ['lake_oswego','Lake Oswego/Riverdale','Lakers','Lake Oswego'],
];

// ── C4 slug -> venue name (verbatim — 41 arms) ──
const HOME_VENUE = {
  oes:'OES', hood_river:'Hood River HS', lincoln:'Lincoln HS', grant:'Grant HS',
  central_catholic:'Central Catholic HS', ida_b_wells:'Ida B Wells-Barnett HS',
  mt_view:'Mt. View HS', bend_caldera:'Caldera HS', burns:'Burns HS', summit:'Summit HS',
  aloha_southridge:'Aloha HS', beaverton:'Beaverton HS', jesuit:'Jesuit HS',
  mountainside:'Mountainside HS', sunset:'Sunset HS', westview:'Westview HS',
  west_albany:'West Albany HS', west_salem:'West Salem HS', corvallis:'Crescent Valley HS',
  sprague:'Sprague HS', newberg:'Newberg HS', sherwood:'Sherwood HS', tigard:'Tigard HS',
  tualatin:'Tualatin HS', wilsonville:'Wilsonville HS', century:'Century HS',
  forest_grove:'Forest Grove HS', glencoe:'Glencoe HS', hillsboro:'Hillsboro HS',
  liberty:'Liberty HS', roseburg:'Roseburg HS', south_eugene:'South Eugene HS',
  marist:'Marist HS', sheldon:'Sheldon HS', thurston:'Thurston HS', canby:'Canby HS',
  lakeridge:'Lakeridge HS', nelson:'Clackamas HS', oregon_city:'Oregon City HS',
  west_linn:'West Linn HS', lake_oswego:'Lake Oswego HS',
};

// ── C5 Oregon aliases (verbatim from runbook) ──
const OR_ALIASES = {
  oes:['oes','Oregon Episcopal','OES','Oregon Episcopal School'],
  hood_river:['hood_river','Hood River'],
  lincoln:['lincoln','Lincoln'],
  grant:['grant','Grant/Central Eastside','grant_central','Grant - Central Eastside','Grant Central Eastside','Grant'],
  central_catholic:['central_catholic','Central Catholic'],
  ida_b_wells:['ida_b_wells','Ida B Wells'],
  mt_view:['mt_view','Mountain View','Mt. View','Mt View','mt view'],
  bend_caldera:['bend_caldera','Bend/Caldera','Bend - Caldera','Bend Caldera','Bend/Caldera HS'],
  burns:['burns','Burns'],
  summit:['summit','Summit'],
  aloha_southridge:['aloha_southridge','Aloha/Southridge','Aloha - Southridge','Aloha Southridge'],
  beaverton:['beaverton','Beaverton'],
  jesuit:['jesuit','Jesuit Portland','Jesuit','Jesuit HS'],
  mountainside:['mountainside','Mountainside'],
  sunset:['sunset','Sunset'],
  westview:['westview','Westview'],
  west_albany:['west_albany','West Albany'],
  west_salem:['west_salem','West Salem/McNary','West Salem - McNary','West Salem McNary','West Salem'],
  corvallis:['corvallis','Corvallis/Crescent Valley','Corvallis - Crescent Valley','Corvallis Crescent Valley','Crescent Valley','Corvallis'],
  sprague:['sprague','Sprague/South Salem','Sprague - South Salem','Sprague South Salem','Sprague HS','South Salem','Sprague'],
  newberg:['newberg','Newberg'],
  sherwood:['sherwood','Sherwood'],
  tigard:['tigard','Tigard'],
  tualatin:['tualatin','Tualatin'],
  wilsonville:['wilsonville','Wilsonville'],
  century:['century','Century'],
  forest_grove:['forest_grove','Forest Grove'],
  glencoe:['glencoe','Glencoe'],
  hillsboro:['hillsboro','Hillsboro'],
  liberty:['liberty','Liberty'],
  roseburg:['roseburg','Roseburg'],
  south_eugene:['south_eugene','South Eugene'],
  marist:['marist','Marist'],
  sheldon:['sheldon','Sheldon'],
  thurston:['thurston','Thurston'],
  canby:['canby','Canby'],
  lakeridge:['lakeridge','Lakeridge'],
  nelson:['nelson','Clackamas/Nelson','clackamas_nelson','Nelson - Clackamas','Nelson Clackamas','Clackamas Nelson','Nelson'],
  oregon_city:['oregon_city','Oregon City'],
  west_linn:['west_linn','West Linn'],
  lake_oswego:['lake_oswego','Lake Oswego/Riverdale','Lake Oswego - Riverdale','Lake Oswego Riverdale','Lake Oswego','Riverdale'],
};

// ── C6 conferences 2026 (verbatim) ──
const CONFERENCES = {
  'Columbia':      ['oes','hood_river','lincoln','grant','central_catholic','ida_b_wells'],
  'High Desert':   ['mt_view','bend_caldera','burns','summit'],
  'Metro':         ['aloha_southridge','beaverton','jesuit','mountainside','sunset','westview'],
  'North Valley':  ['west_albany','west_salem','corvallis','sprague'],
  'Northwest':     ['newberg','sherwood','tigard','tualatin','wilsonville'],
  'Pacific':       ['century','forest_grove','glencoe','hillsboro','liberty'],
  'Southwest':     ['roseburg','south_eugene','marist','sheldon','thurston'],
  'Three Rivers':  ['canby','lakeridge','nelson','oregon_city','west_linn','lake_oswego'],
};

// ── C8 spot tests (borah entries adapted to actual raw strings) ──
const SPOT_TESTS = [
  ['mt_view','mt_view'], ['Mountain View','mt_view'], ['Mt. View','mt_view'],
  ['grant','grant'], ['Grant/Central Eastside','grant'], ['Grant Central Eastside','grant'],
  ['nelson','nelson'], ['Clackamas/Nelson','nelson'], ['Nelson','nelson'],
  ['Corvallis','corvallis'], ['Crescent Valley','corvallis'],
  ['West Salem','west_salem'],
  ['borah_id','borah_id'], ['Borah HS, ID','borah_id'],
];

const report = [`# Section C Report\n\nGenerated: ${new Date().toISOString()}\n`];
const gates = [];
function gate(name, ok, detail) {
  gates.push([name, ok, detail]);
  console.log(`${ok ? 'GO   ' : 'NO-GO'}  ${name}${detail ? ' — ' + detail : ''}`);
  report.push(`- ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });

  // ── C1: venues ──
  await conn.query(
    'INSERT IGNORE INTO venues (name, city, state) VALUES ' + VENUES.map(() => "(?,?,'OR')").join(','),
    VENUES.flat());
  const [[{ vc }]] = await conn.query('SELECT COUNT(*) AS vc FROM venues');
  gate('C1: 41 venues seeded', vc === 41, `count=${vc}`);

  // ── C2: Oregon teams ──
  await conn.query(
    "INSERT IGNORE INTO teams (slug, name, mascot, city, state) VALUES " + OR_TEAMS.map(() => "(?,?,?,?,'OR')").join(','),
    OR_TEAMS.flat());
  const [[{ tc }]] = await conn.query("SELECT COUNT(*) AS tc FROM teams WHERE state = 'OR'");
  gate('C2: 41 Oregon teams seeded', tc === 41, `count=${tc}`);

  // ── C3: out-of-state placeholders + aliases (from a7-classification.json) ──
  for (const t of A7.out_of_state_placeholders) {
    await conn.query('INSERT IGNORE INTO teams (slug, name, city, state) VALUES (?,?,NULL,?)',
      [t.slug, t.name, t.state]);
    const aliases = [...new Set([t.slug, t.name, t.opponent].map(a => a.trim()))];
    for (const a of aliases) {
      await conn.query(
        `INSERT IGNORE INTO team_aliases (team_id, alias, source)
         SELECT id, ?, 'a7-classification' FROM teams WHERE slug = ?`, [a, t.slug]);
    }
  }
  const [oosCounts] = await conn.query(
    "SELECT state, COUNT(*) AS cnt FROM teams WHERE state != 'OR' GROUP BY state ORDER BY cnt DESC");
  const oosTotal = oosCounts.reduce((s, r) => s + r.cnt, 0);
  gate(`C3: ${A7.out_of_state_placeholders.length} out-of-state teams seeded`, oosTotal === A7.out_of_state_placeholders.length,
    oosCounts.map(r => `${r.state}=${r.cnt}`).join(', '));

  // ── C4: home venues ──
  for (const [slug, venue] of Object.entries(HOME_VENUE)) {
    await conn.query(
      `UPDATE teams t JOIN venues v ON v.name = ? SET t.home_venue_id = v.id WHERE t.slug = ?`,
      [venue, slug]);
  }
  const [nullVenues] = await conn.query(
    "SELECT slug FROM teams WHERE state = 'OR' AND home_venue_id IS NULL");
  gate('C4: all 41 OR teams have home_venue_id', nullVenues.length === 0,
    nullVenues.length ? 'NULL: ' + nullVenues.map(r => r.slug).join(', ') : 'zero NULLs');
  const [[spot]] = await conn.query(
    `SELECT t.slug, v.name AS venue, v.city FROM teams t JOIN venues v ON v.id = t.home_venue_id WHERE t.slug = 'mt_view'`);
  gate('C4 spot-check: mt_view -> Mt. View HS, Bend', spot && spot.venue === 'Mt. View HS' && spot.city === 'Bend', JSON.stringify(spot));

  // ── C5: Oregon aliases ──
  for (const [slug, aliases] of Object.entries(OR_ALIASES)) {
    for (const a of aliases) {
      await conn.query(
        `INSERT IGNORE INTO team_aliases (team_id, alias, source)
         SELECT id, ?, 'mockdata' FROM teams WHERE slug = ?`, [a, slug]);
    }
  }
  // GATE ADAPTED (2026-07-10): runbook's "≥2 aliases per team" contradicts its own
  // INSERT IGNORE note — single-word teams legitimately collapse slug+name into ONE
  // row that resolves BOTH strings. Real invariant: slug AND display name resolve.
  const [zeroAlias] = await conn.query(
    `SELECT t.slug FROM teams t LEFT JOIN team_aliases ta ON ta.team_id = t.id
     WHERE t.state = 'OR' GROUP BY t.slug, t.id HAVING COUNT(ta.id) = 0`);
  const [unresolvedSelf] = await conn.query(
    `SELECT t.slug FROM teams t
     LEFT JOIN team_aliases s ON s.team_id = t.id AND s.alias_normalized = LOWER(TRIM(t.slug))
     LEFT JOIN team_aliases n ON n.team_id = t.id AND n.alias_normalized = LOWER(TRIM(t.name))
     WHERE t.state = 'OR' AND (s.id IS NULL OR n.id IS NULL)`);
  const [[{ orAliases }]] = await conn.query(
    `SELECT COUNT(*) AS orAliases FROM team_aliases ta JOIN teams t ON t.id = ta.team_id WHERE t.state = 'OR'`);
  gate('C5 (adapted): every OR team has ≥1 alias; slug AND name both resolve',
    zeroAlias.length === 0 && unresolvedSelf.length === 0,
    `zero-alias teams: ${zeroAlias.length}, slug/name resolution gaps: ${unresolvedSelf.length}, total OR alias rows: ${orAliases}`);

  // ── C6: team_seasons 2026 ──
  for (const [conf, slugs] of Object.entries(CONFERENCES)) {
    await conn.query(
      `INSERT IGNORE INTO team_seasons (team_id, season, conference)
       SELECT id, 2026, ? FROM teams WHERE slug IN (${slugs.map(() => '?').join(',')})`,
      [conf, ...slugs]);
  }
  const [confRows] = await conn.query(
    `SELECT conference, COUNT(*) AS n FROM team_seasons WHERE season = 2026 GROUP BY conference ORDER BY conference`);
  const expected = { 'Columbia':6,'High Desert':4,'Metro':6,'North Valley':4,'Northwest':5,'Pacific':5,'Southwest':5,'Three Rivers':6 };
  const confOk = confRows.length === 8 && confRows.every(r => expected[r.conference] === r.n);
  gate('C6: 8 conferences, 41 team_seasons', confOk, confRows.map(r => `${r.conference}=${r.n}`).join(', '));

  // ── C7: coaches (NON-IDEMPOTENT — guarded) ──
  const [[{ cc }]] = await conn.query('SELECT COUNT(*) AS cc FROM coaches');
  if (cc === 0) {
    await conn.query(`INSERT INTO coaches (full_name) VALUES ('Charles Raub'),('John McGuire'),('Mason Ludwig'),('Kyle Cardinal')`);
    const links = [['Charles Raub','head'],['John McGuire','assistant'],['Mason Ludwig','assistant'],['Kyle Cardinal','assistant']];
    for (const [name, role] of links) {
      await conn.query(
        `INSERT IGNORE INTO team_coaches (team_id, coach_id, season, role, source)
         SELECT t.id, c.id, 2026, ?, 'mockdata' FROM teams t JOIN coaches c ON c.full_name = ? WHERE t.slug = 'mt_view'`,
        [role, name]);
    }
    const [[{ cc2 }]] = await conn.query('SELECT COUNT(*) AS cc2 FROM coaches');
    const [[{ tcn }]] = await conn.query(
      `SELECT COUNT(*) AS tcn FROM team_coaches tc JOIN teams t ON t.id = tc.team_id WHERE t.slug = 'mt_view' AND tc.season = 2026`);
    gate('C7: 4 coaches + 4 mt_view links', cc2 === 4 && tcn === 4, `coaches=${cc2}, links=${tcn}`);
  } else {
    const [[{ tcn }]] = await conn.query(
      `SELECT COUNT(*) AS tcn FROM team_coaches tc JOIN teams t ON t.id = tc.team_id WHERE t.slug = 'mt_view' AND tc.season = 2026`);
    gate('C7: skipped (coaches already populated — guard per runbook)', cc === 4 && tcn === 4,
      `existing coaches=${cc}, mt_view links=${tcn} — verify this is from a prior C7 run, not something unexpected`);
  }

  // ── C8: alias resolution spot-tests ──
  let spotOk = true; const spotResults = [];
  for (const [val, expectedSlug] of SPOT_TESTS) {
    const [rows] = await conn.query(
      `SELECT t.slug FROM team_aliases ta JOIN teams t ON t.id = ta.team_id
       WHERE ta.alias_normalized = LOWER(TRIM(?))`, [val]);
    const got = rows.length === 1 ? rows[0].slug : `(${rows.length} rows)`;
    if (got !== expectedSlug) spotOk = false;
    spotResults.push(`'${val}' -> ${got}${got === expectedSlug ? '' : ' EXPECTED ' + expectedSlug}`);
  }
  gate('C8: 14 alias spot-tests', spotOk, spotOk ? 'all resolve correctly' : spotResults.filter(s => s.includes('EXPECTED')).join('; '));
  report.push('\n<details><summary>C8 detail</summary>\n\n' + spotResults.map(s => `- ${s}`).join('\n') + '\n</details>\n');

  // ── C8.5: every team_schedules opponent resolves (Team Place Holder excluded + logged) ──
  await conn.query(
    `INSERT INTO unresolved_aliases (raw_name, source, context, occurrence_count)
     VALUES ('Team Place Holder', 'ohsla', 'TBD placeholder rows — intentionally excluded from backfill; verified scoreless 2026-07-10', 9)
     ON DUPLICATE KEY UPDATE context = VALUES(context)`);
  // COLLATION NOTE: legacy tables are utf8mb4_general_ci, new tables utf8mb4_0900_ai_ci.
  // Column-vs-column comparison across that boundary errors ("illegal mix of collations"),
  // so both sides are CONVERTed to an explicit common collation. Values are pre-lowercased,
  // so general_ci here is purely a tie-breaker. Same treatment required in D1's JOIN.
  const [unresolvedOpp] = await conn.query(
    `SELECT g.opponent AS still_unresolved, COUNT(*) AS occurrences
     FROM team_schedules g
     LEFT JOIN team_aliases ta
       ON CONVERT(ta.alias_normalized USING utf8mb4) COLLATE utf8mb4_general_ci
        = CONVERT(LOWER(TRIM(g.opponent)) USING utf8mb4) COLLATE utf8mb4_general_ci
     WHERE ta.id IS NULL AND g.opponent != 'Team Place Holder'
     GROUP BY g.opponent ORDER BY occurrences DESC`);
  gate('C8.5: 0 unresolved opponents in team_schedules', unresolvedOpp.length === 0,
    unresolvedOpp.length ? unresolvedOpp.map(r => `'${r.still_unresolved}' x${r.occurrences}`).join(', ') : 'all resolve (placeholder excluded + logged)');

  // Also verify all team_id slugs resolve (D1 joins on both sides)
  const [unresolvedSlugs] = await conn.query(
    `SELECT DISTINCT g.team_id FROM team_schedules g
     LEFT JOIN team_aliases ta
       ON CONVERT(ta.alias_normalized USING utf8mb4) COLLATE utf8mb4_general_ci
        = CONVERT(LOWER(TRIM(g.team_id)) USING utf8mb4) COLLATE utf8mb4_general_ci
     WHERE ta.id IS NULL`);
  gate('C8.5b: 0 unresolved team_id slugs', unresolvedSlugs.length === 0,
    unresolvedSlugs.length ? unresolvedSlugs.map(r => r.team_id).join(', ') : 'all resolve');

  // ── C9: sign-off counts ──
  const [c9] = await conn.query(
    `SELECT 'venues' AS tbl, COUNT(*) AS row_count FROM venues
     UNION ALL SELECT 'teams', COUNT(*) FROM teams
     UNION ALL SELECT 'team_aliases', COUNT(*) FROM team_aliases
     UNION ALL SELECT 'team_seasons', COUNT(*) FROM team_seasons
     UNION ALL SELECT 'coaches', COUNT(*) FROM coaches
     UNION ALL SELECT 'team_coaches', COUNT(*) FROM team_coaches`);
  report.push('\n## C9 counts\n\n' + c9.map(r => `- ${r.tbl}: ${r.row_count}`).join('\n'));
  console.log('\nC9 counts:', c9.map(r => `${r.tbl}=${r.row_count}`).join(', '));

  const allGo = gates.every(g => g[1]);
  report.push(`\n## Section C: ${allGo ? '**GO — proceed to Section D**' : '**NO-GO — see failures above**'}\n`);
  console.log(`\nSection C overall: ${allGo ? 'GO' : 'NO-GO'}`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'section-c-report.md'), report.join('\n'));
  console.log('Report: db/migrate/out/section-c-report.md');
  await conn.end();
  if (!allGo) process.exit(1);
}

main().catch(e => {
  console.error('SECTION C FAILED:', e.message);
  report.push(`\n## CRASHED\n\n\`${e.message}\`\n`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'section-c-report.md'), report.join('\n'));
  process.exit(1);
});
