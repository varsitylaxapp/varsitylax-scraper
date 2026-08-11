#!/usr/bin/env node
//
// cross-state-audit.js — the CROSS-STATE COLLISION FAMILY, both directions.
//
// WHY THIS EXISTS
//
// A high-school name is not a key. "Liberty" is a school in Oregon and a school in
// Washington; "Mountain View" is three schools in three states. `team_aliases` knows
// this — it carries a `state` column and its uniqueness is per-state — but
// `dual-write.js:writeGames` loads the alias map with NO state filter and folds it into
// a `Map` keyed by the bare normalized name:
//
//     for (const r of rows) map.set(r.a, r);      // last row wins, globally
//
// The comment above that call explains the intent, and the intent is right: an OHSLA
// schedule legitimately names out-of-state opponents, so games cannot resolve inside one
// state the way rankings do. What it does not do is disambiguate. Every source's every
// game resolves "liberty" to whichever team happened to sort last.
//
// The damage has TWO shapes, and a check that looks for one will report the other clean:
//
//   (A) ROWS MIS-CREATED.  A cross-border game names a school that has no alias in the
//       resolving namespace, so a NEW team row appears — `brophy_az` beside the real
//       `brophy_prep_az`. Signature: a team whose every game is against another state.
//
//   (B) GAMES MIS-ATTRIBUTED.  A cross-border game names a school that DOES have an
//       alias — belonging to the wrong state's team. No new row appears, nothing looks
//       wrong in any count, and the game lands on a real team in another state.
//       Signature: two games, same date, same third team, two same-named teams.
//
// (B) is the dangerous one precisely because it is invisible to every check that counts
// rows. It was found by a WHSBLA board member reading his own league's schedule and
// seeing Oregon opponents on it — which is to say, by a human, in production.
//
// USAGE
//     node scripts/cross-state-audit.js [--season 2026] [--json] [--target=staging]
//
// EXIT
//     0  no findings
//     1  findings (this is a GATE — it belongs in the import suite, before and after)
//     2  could not run

const db = require('./../src/db');
const { listStates } = require('./../src/config/states');

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');

// SEASON, parsed so that a bad parse STOPS rather than proceeds.
//
// The first version of this took `--season` either as `=N` or as the next argv entry,
// and `node cross-state-audit.js --json` made `indexOf('--season')` return -1, so the
// "next entry" was argv[0] — `--json` — and the season became NaN. Every query then
// matched nothing and the audit printed a clean verdict and exited 0. **It was wired
// into the rehearsal gate at the time.** A gate that reports clean because it asked the
// database about season NaN is the vacuous-pass family this repo keeps cataloguing, and
// it is worse than no gate because it is believed.
const seasonFlag = args.find(a => a.startsWith('--season='));
const seasonPos = args.indexOf('--season') >= 0 ? args[args.indexOf('--season') + 1] : undefined;
const rawSeason = (seasonFlag ? seasonFlag.split('=')[1] : seasonPos) ?? process.env.SEASON ?? '2026';
const SEASON = parseInt(rawSeason, 10);
if (!Number.isInteger(SEASON) || SEASON < 2000 || SEASON > 2100) {
  console.error(`[cross-state-audit] FATAL: bad season ${JSON.stringify(rawSeason)}`);
  process.exit(2);
}

// Which state a SOURCE speaks for. Derived from the registry rather than hardcoded, so a
// new state's league arrives with its own scheduleSource label and needs no edit here.
//
// `backfill` is the one entry that cannot come from the registry: it is the v1→v2
// migration of the Oregon-only era, and there was no state column to read at the time.
const SOURCE_STATE = { backfill: 'OR' };
for (const s of listStates()) {
  const label = s.scheduleSource && s.scheduleSource.label;
  if (label) SOURCE_STATE[label.toLowerCase()] = s.code;
}

const out = { season: SEASON, misCreated: [], misAttributed: [], duplicatePairs: [], ambiguous: [] };

async function q(sql, p = []) { return (await db.execute(sql, p))[0]; }

// ── (A) rows that exist only because someone else's schedule named them ──────
//
// COVERED STATES ONLY, and that restriction is the whole check rather than a detail.
// Run unrestricted it returns forty-five rows and is useless: Oregon plays tournaments,
// so Mater Dei and Strake Jesuit and forty others exist in `teams` with no in-state
// games and never will — we do not cover California or Texas, and an opponent-only row
// there is the CORRECT representation, not a defect. The signature only means something
// where we import the state's own season, because only there should a school already
// have a row of its own. Reporting the other forty is how a gate teaches people to
// ignore it.
const COVERED = new Set(listStates().map(s => s.code));

async function misCreatedRows() {
  const rows = await q(`
    SELECT t.id, t.slug, t.state, t.name,
           COUNT(*)                                             AS games,
           SUM(CASE WHEN opp.state = t.state THEN 1 ELSE 0 END) AS sameStateGames
    FROM teams t
    JOIN games g   ON t.id IN (g.home_team_id, g.away_team_id) AND g.season = ?
    JOIN teams opp ON opp.id = IF(g.home_team_id = t.id, g.away_team_id, g.home_team_id)
    WHERE t.state IN (${[...COVERED].map(() => '?').join(',')})
    GROUP BY t.id
    HAVING sameStateGames = 0`, [SEASON, ...COVERED]);

  for (const r of rows) {
    // A same-state sibling is what turns "thin row" into "duplicate". Matched on the
    // leading significant word of the NAME, not on a shared alias: these rows are
    // duplicates precisely because they never shared an alias — "Brophy College Prep"
    // and "Brophy Prep" resolve apart, which is how both came to exist.
    const lead = String(r.name).toLowerCase()
      .replace(/[^a-z ]+/g, ' ')
      .split(/\s+/).filter(w => w.length > 2 && !['the', 'high', 'school', 'saint'].includes(w))[0];
    const sib = lead ? await q(
      `SELECT slug FROM teams WHERE state = ? AND id <> ? AND LOWER(name) LIKE CONCAT(?, '%')`,
      [r.state, r.id, lead]) : [];
    out.misCreated.push({
      slug: r.slug, state: r.state, name: r.name, games: Number(r.games),
      sameStateSiblings: sib.map(s => s.slug),
    });
  }
}

// ── names that cannot be resolved without a state ────────────────────────────
async function ambiguousNames() {
  return q(`
    SELECT ta.alias_normalized AS alias,
           GROUP_CONCAT(CONCAT(t.state, ':', t.slug) ORDER BY t.state) AS candidates
    FROM team_aliases ta JOIN teams t ON t.id = ta.team_id
    GROUP BY ta.alias_normalized
    HAVING COUNT(DISTINCT t.state) > 1`);
}

// ── (B) games whose resolved side is in the wrong state ──────────────────────
//
// THE QUERY, stated plainly: every game whose resolved opponent's state differs from the
// state its SOURCE speaks for, where a same-state candidate for that raw name exists.
// The last clause is what separates a mis-resolution from a real cross-border fixture —
// Oregon genuinely plays Idaho, and that is not a finding.
async function misAttributedGames(ambiguous) {
  const byAlias = new Map(ambiguous.map(a => [a.alias, a.candidates.split(',')]));
  if (!byAlias.size) return;

  const rows = await q(`
    SELECT gsr.id, gsr.source, gsr.home_team_raw, gsr.away_team_raw,
           g.id AS gameId, g.game_date, g.canonical_source,
           ht.slug AS homeSlug, ht.state AS homeState,
           at2.slug AS awaySlug, at2.state AS awayState
    FROM game_source_records gsr
    JOIN games g   ON g.id = gsr.game_id AND g.season = ?
    JOIN teams ht  ON ht.id = g.home_team_id
    JOIN teams at2 ON at2.id = g.away_team_id`, [SEASON]);

  for (const r of rows) {
    const srcState = SOURCE_STATE[String(r.source).toLowerCase()];
    if (!srcState) continue;               // per-state importer; side below covers it
    for (const [rawKey, slug, state] of [
      ['home_team_raw', r.homeSlug, r.homeState],
      ['away_team_raw', r.awaySlug, r.awayState],
    ]) {
      const raw = (r[rawKey] || '').trim().toLowerCase();
      const candidates = byAlias.get(raw);
      if (!candidates) continue;
      if (state === srcState) continue;                                   // resolved locally
      if (!candidates.some(c => c.startsWith(srcState + ':'))) continue;  // no local option: real fixture
      out.misAttributed.push({
        gameId: r.gameId, date: String(r.game_date).slice(0, 10), source: r.source,
        sourceState: srcState, raw: r[rawKey], resolvedTo: `${state}:${slug}`,
        shouldBe: candidates.find(c => c.startsWith(srcState + ':')),
        opponent: slug === r.homeSlug ? `${r.awayState}:${r.awaySlug}` : `${r.homeState}:${r.homeSlug}`,
      });
    }
  }
}

// ── the reassignment list: one real fixture sitting in the table twice ───────
async function duplicatePairs() {
  const rows = await q(`
    SELECT g1.id AS id1, g2.id AS id2, g1.game_date AS d,
           a.slug AS slugA, a.state AS stateA, b.slug AS slugB, b.state AS stateB,
           o.slug AS opponent, o.state AS opponentState,
           g1.canonical_source AS src1, g2.canonical_source AS src2
    FROM games g1
    JOIN games g2 ON g2.game_date = g1.game_date AND g2.season = g1.season AND g2.id > g1.id
    JOIN teams a  ON a.id IN (g1.home_team_id, g1.away_team_id)
    JOIN teams b  ON b.id IN (g2.home_team_id, g2.away_team_id)
    JOIN teams o  ON o.id IN (g1.home_team_id, g1.away_team_id)
                 AND o.id IN (g2.home_team_id, g2.away_team_id)
    JOIN team_aliases aa ON aa.team_id = a.id
    JOIN team_aliases ba ON ba.team_id = b.id AND ba.alias_normalized = aa.alias_normalized
    WHERE g1.season = ? AND a.id <> b.id AND a.id <> o.id AND b.id <> o.id AND a.state <> b.state
    ORDER BY g1.game_date`, [SEASON]);

  const seen = new Set();
  for (const r of rows) {
    const key = `${r.id1}|${r.id2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.duplicatePairs.push({
      date: String(r.d).slice(0, 10),
      keep: `${r.stateA}:${r.slugA}`, keepGameId: r.id1,
      drop: `${r.stateB}:${r.slugB}`, dropGameId: r.id2,
      sharedOpponent: `${r.opponentState}:${r.opponent}`,
      sources: [r.src1, r.src2],
    });
  }
}

function report() {
  const n = out.misCreated.length + out.misAttributed.length + out.duplicatePairs.length;
  if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); return n; }

  console.log(`\n══ CROSS-STATE AUDIT — season ${SEASON} ══\n`);

  console.log(`── ambiguous names (a name that cannot resolve without a state) — ${out.ambiguous.length}`);
  for (const a of out.ambiguous) console.log(`   "${a.alias}" → ${a.candidates}`);

  console.log(`\n── (A) rows MIS-CREATED by cross-border resolution — ${out.misCreated.length}`);
  for (const r of out.misCreated) {
    console.log(`   ${r.state}:${r.slug.padEnd(22)} "${r.name}"  ${r.games} game(s), none in-state`
      + (r.sameStateSiblings.length ? `  → duplicate of ${r.sameStateSiblings.join(', ')}` : `  → no same-state sibling; may be a real out-of-state-only program`));
  }

  console.log(`\n── (B) games MIS-ATTRIBUTED to an existing same-name team — ${out.misAttributed.length}`);
  for (const r of out.misAttributed) {
    console.log(`   #${String(r.gameId).padEnd(6)} ${r.date}  ${r.source}(${r.sourceState})  "${r.raw}" → ${r.resolvedTo}  should be ${r.shouldBe}   vs ${r.opponent}`);
  }

  console.log(`\n── reassignment list: one fixture, two rows — ${out.duplicatePairs.length} pair(s)`);
  for (const r of out.duplicatePairs) {
    console.log(`   ${r.date}  keep #${String(r.keepGameId).padEnd(6)} ${r.keep.padEnd(18)} drop #${String(r.dropGameId).padEnd(6)} ${r.drop.padEnd(18)} both vs ${r.sharedOpponent}`);
  }

  console.log(`\n── VERDICT: ${n === 0 ? 'clean' : `${n} finding(s)`}\n`);
  return n;
}

(async () => {
  out.ambiguous = await ambiguousNames();
  await misCreatedRows();
  await misAttributedGames(out.ambiguous);
  await duplicatePairs();
  const n = report();
  process.exit(n === 0 ? 0 : 1);
})().catch(err => { console.error('[cross-state-audit] FATAL:', err.message); process.exit(2); });
