/**
 * Identity for the LaxNumbers game import: name normalisation, the team indexes, and the
 * rulings that travel with the code. Moved verbatim from scripts/import-laxnumbers-games.js;
 * the reasoning behind each lookup lives in that script's header.
 */
const fs = require('fs');
const path = require('path');

const norm  = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const loose = s => norm(s).replace(/\b(high school|hs|school|academy|prep|the)\b/g, '').replace(/\s+/g, ' ').trim();

/**
 * Human rulings on placeholder origin. A name absent from the file stays NULL and renders
 * untagged — the honest outcome, not a gap for the importer to fill.
 */
const RULINGS = (() => {
  const f = path.join(__dirname, '..', '..', 'data', 'placeholder-states.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const m = new Map();
  for (const p of d.placeholders) m.set(norm(p.name), p);
  return m;
})();

/**
 * NEGATIVE DECISIONS — merges that must never be proposed again.
 *
 * A name-similarity sweep will suggest each of these every time it runs, and each one is
 * WRONG. Recorded here so the answer travels with the code rather than living in a memory
 * of a conversation.
 */
const DO_NOT_MERGE = [
  { keep: 'Brophy Prep II', never: 'brophy_az', why:
    'A JV / second squad. Merging its games into the varsity team would corrupt the ' +
    'varsity record — the same class of mistake as losing game_type, in team form. ' +
    'The name similarity guarantees every future sweep proposes exactly this merge.' },
];

const slugify = (name, suffix) =>
  norm(name).replace(/\s+/g, '_').slice(0, 56) + (suffix || '');

/** Every team we know about, by both strict and loose name, plus curated aliases. */
function buildIndexes(teams, aliases) {
  const idx = new Map(), looseIdx = new Map();
  for (const t of teams) {
    idx.set(norm(t.name), t.id); idx.set(norm(t.slug), t.id);
    looseIdx.set(loose(t.name), t.id); looseIdx.set(loose(t.slug), t.id);
  }
  for (const a of aliases) { idx.set(norm(a.alias), a.team_id); looseIdx.set(loose(a.alias), a.team_id); }
  const byId = new Map(teams.map(t => [t.id, t]));
  const teamState = new Map(teams.map(t => [t.id, t.state ?? null]));
  const stateIdx = new Map(), stateLooseIdx = new Map();
  for (const t of teams) {
    if (!t.state) continue;
    if (!stateIdx.has(t.state)) { stateIdx.set(t.state, new Map()); stateLooseIdx.set(t.state, new Map()); }
    stateIdx.get(t.state).set(norm(t.name), t.id);
    stateIdx.get(t.state).set(norm(t.slug), t.id);
    stateLooseIdx.get(t.state).set(loose(t.name), t.id);
    stateLooseIdx.get(t.state).set(loose(t.slug), t.id);
  }

  // A rated team in a ROSTER-LOCKED feed resolves in the FEED's state first, then in the
  // state LaxNumbers tags it with. League membership beats geography: Hermiston is an
  // Oregon town in WHSBLA, rostered as hermiston_wa, and tagged OR by LaxNumbers.
  // No global fallback, no stateless placeholder.
  //
  // Curated aliases count, scoped by the alias row's own state: a display rename keeps its
  // old name as an alias ("Mountain View" → mountain_view_wa, now "Mountain View (WA)"),
  // and the lock must still find it.
  const stateAliasIdx = new Map(), stateAliasLooseIdx = new Map();
  for (const a of aliases) {
    if (!a.state) continue;
    if (!stateAliasIdx.has(a.state)) { stateAliasIdx.set(a.state, new Map()); stateAliasLooseIdx.set(a.state, new Map()); }
    stateAliasIdx.get(a.state).set(norm(a.alias), a.team_id);
    stateAliasLooseIdx.get(a.state).set(loose(a.alias), a.team_id);
  }
  const lockedSelfId = (t, code) => {
    for (const s of [code, t.state].filter(Boolean)) {
      const id = stateIdx.get(s)?.get(norm(t.name)) ?? stateAliasIdx.get(s)?.get(norm(t.name))
              ?? stateLooseIdx.get(s)?.get(loose(t.name)) ?? stateAliasLooseIdx.get(s)?.get(loose(t.name));
      if (id != null) return id;
    }
    return null;
  };

  return { idx, looseIdx, byId, teamState, stateIdx, stateLooseIdx,
           stateAliasIdx, stateAliasLooseIdx, lockedSelfId };
}

module.exports = { norm, loose, RULINGS, DO_NOT_MERGE, slugify, buildIndexes };
