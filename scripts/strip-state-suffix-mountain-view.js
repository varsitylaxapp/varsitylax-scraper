#!/usr/bin/env node
/**
 * Strip the "(WA)" suffix from mountain_view_wa's display name.
 *
 * RULING (2026-07-29): canonical display names are context-free; disambiguation is
 * the out-of-state tag's job, derived per viewing context. `mountain_view_wa` was
 * the only team of 159 carrying a bracketed state in its name, and the suffix was
 * actively wrong in Washington's own context, where it stated the state twice.
 *
 * A SCRIPT RATHER THAN PASTED SQL because prod runs it later, from a release
 * runbook, and the two environments need DIFFERENT statements:
 *
 *     staging  the bare "Mountain View" alias already exists (source=whsbla-2026)
 *     prod     it does NOT — after the rename the team's own display name would
 *              not resolve back to it, so the alias must be inserted
 *
 * The script reconciles that itself instead of asking whoever runs it to remember
 * which environment needs which.
 *
 *   node scripts/strip-state-suffix-mountain-view.js --target=staging [--commit]
 *   node scripts/strip-state-suffix-mountain-view.js --commit          (prod)
 *
 * Dry run by default: it prints what it would do and rolls back.
 *
 * PROD IS SEQUENCED, NOT MERELY PERMITTED. Run it only AFTER the App Store build
 * carrying the out-of-state tag is LIVE — approved and released, not just
 * submitted. Until the tag ships, the suffix is the only thing distinguishing this
 * team from Oregon's own "Mountain View" on a prod user's screen. Renaming first
 * would open a window where a prod user sees a bare "Mountain View" against
 * Hillsboro with nothing marking it as Washington. See RELEASE.md.
 */
const pool = require('../src/db');

const SLUG = 'mountain_view_wa';
const OLD  = 'Mountain View (WA)';
const NEW  = 'Mountain View';
const COMMIT = process.argv.includes('--commit');

(async () => {
  const c = await pool.getConnection();
  const target = pool.targetLabel;
  console.log(`\n  target: ${pool.targetDescription}`);
  console.log(`  mode:   ${COMMIT ? 'COMMIT' : 'DRY RUN (rolls back)'}\n`);

  try {
    await c.beginTransaction();

    const [[team]] = await c.execute(
      'SELECT id, slug, name, state FROM teams WHERE slug = ?', [SLUG]);
    if (!team) throw new Error(`${SLUG} not found on ${target}`);
    console.log(`  team ${team.id}: "${team.name}" (state=${team.state})`);

    if (team.name === NEW) {
      console.log('  already renamed — nothing to do');
      await c.rollback();
      return;
    }
    if (team.name !== OLD) {
      throw new Error(`unexpected current name "${team.name}"; expected "${OLD}". ` +
                      'Refusing to guess — someone changed this outside the script.');
    }

    // 1. the rename
    const [r1] = await c.execute(
      'UPDATE teams SET name = ? WHERE slug = ? AND name = ?', [NEW, SLUG, OLD]);
    console.log(`  UPDATE teams SET name='${NEW}'  → ${r1.affectedRows} row(s)`);
    if (r1.affectedRows !== 1) throw new Error('expected exactly 1 row updated');

    // 2. the aliases that must exist afterwards, inserted only if absent.
    //    alias_normalized is a STORED GENERATED column and the unique key is
    //    (state, alias_normalized) — so ('WA','mountain view') cannot collide with
    //    Oregon's ('OR','mountain view'). The schema disambiguates where the
    //    display name used to.
    for (const alias of [OLD, NEW]) {
      const [[existing]] = await c.execute(
        `SELECT id FROM team_aliases
          WHERE team_id = ? AND alias_normalized = LOWER(REPLACE(TRIM(?), '-', ' '))`,
        [team.id, alias]);
      if (existing) {
        console.log(`  alias "${alias}" already present (id=${existing.id}) — skipped`);
        continue;
      }
      const [r2] = await c.execute(
        'INSERT INTO team_aliases (team_id, state, alias, source) VALUES (?, ?, ?, ?)',
        [team.id, team.state, alias, 'suffix-strip-2026-07-29']);
      console.log(`  INSERT alias "${alias}"  → id=${r2.insertId}`);
    }

    // 3. prove both directions resolve before deciding to keep any of it
    for (const probe of [OLD, NEW]) {
      const [rows] = await c.execute(
        `SELECT t.slug FROM team_aliases a JOIN teams t ON t.id = a.team_id
          WHERE a.state = ? AND a.alias_normalized = LOWER(REPLACE(TRIM(?), '-', ' '))`,
        [team.state, probe]);
      const slugs = rows.map(r => r.slug);
      const ok = slugs.length === 1 && slugs[0] === SLUG;
      console.log(`  resolve "${probe}" (state=${team.state}) → ${JSON.stringify(slugs)} ${ok ? 'OK' : 'FAIL'}`);
      if (!ok) throw new Error(`"${probe}" no longer resolves to ${SLUG}`);
    }

    // 4. and that Oregon's Mountain View is untouched
    const [orRows] = await c.execute(
      `SELECT t.slug, t.name FROM team_aliases a JOIN teams t ON t.id = a.team_id
        WHERE a.state = 'OR' AND a.alias_normalized = 'mountain view'`);
    console.log(`  Oregon "Mountain View" still resolves → ${JSON.stringify(orRows.map(r => r.slug))}`);
    if (!orRows.some(r => r.slug === 'mt_view')) {
      throw new Error('Oregon mt_view no longer resolves — aborting');
    }

    if (COMMIT) {
      await c.commit();
      console.log('\n  COMMITTED\n');
    } else {
      await c.rollback();
      console.log('\n  rolled back (dry run) — pass --commit to apply\n');
    }
  } catch (err) {
    await c.rollback();
    console.error(`\n  ROLLED BACK: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
