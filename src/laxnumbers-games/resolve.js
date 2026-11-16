/**
 * Identity for the LaxNumbers game import: name normalisation, the team indexes, and the
 * rulings that travel with the code. Moved verbatim from scripts/import-laxnumbers-games.js;
 * the reasoning behind each lookup lives in that script's header.
 */
const fs = require('fs');
const path = require('path');
const { identity } = require('./teams');

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

/**
 * FOREIGN-ROW RULINGS, Spencer 2026-11-13 (data/foreign-row-rulings.json). A rated row
 * tagged with another state that matches ONLY through the feed's state is attached only
 * when ruled here, to the ruled team. Keyed feed|norm(name) → team slug.
 */
function loadForeignRowRulings(rows) {
  const src = rows ?? JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'data', 'foreign-row-rulings.json'), 'utf8')).rows;
  const m = new Map();
  for (const r of src) m.set(`${String(r.feed).toUpperCase()}|${norm(r.name)}`, r.team);
  return m;
}

/**
 * RULED-OUT GAMES (data/ruled-out-games.json): never imported, checked before every
 * insert. Keyed season|date|lowSlug|highSlug — unordered, so a home/away flip matches.
 */
const ruledOutKey = (season, date, slugA, slugB) =>
  `${season}|${date}|${[slugA, slugB].sort().join('|')}`;
function loadRuledOutGames(rows) {
  const src = rows ?? JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'data', 'ruled-out-games.json'), 'utf8')).rows;
  const m = new Map();
  for (const r of src) m.set(ruledOutKey(r.season, r.date, r.teams[0], r.teams[1]), r);
  return m;
}

/** team_nbr → [{ feed, row }] over every ratings feed fetched (Map code → rows). */
function indexRatedByNumber(ratings) {
  const m = new Map();
  for (const [feed, rows] of ratings) {
    for (const row of rows) {
      if (row.team_nbr == null) continue;
      const n = Number(row.team_nbr);
      if (!m.has(n)) m.set(n, []);
      m.get(n).push({ feed, row });
    }
  }
  return m;
}

const slugify = (name, suffix) =>
  norm(name).replace(/\s+/g, '_').slice(0, 56) + (suffix || '');

/** Every team we know about, by both strict and loose name, plus curated aliases. */
function buildIndexes(teams, aliases, { foreignRulings, ruledOutGames } = {}) {
  const FOREIGN = loadForeignRowRulings(foreignRulings);
  const RULED_OUT = loadRuledOutGames(ruledOutGames);
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

  // Curated aliases count, scoped by the alias row's own state: a display rename keeps its
  // old name as an alias ("Mountain View" → mountain_view_wa, now "Mountain View (WA)"),
  // and a state-scoped lookup must still find it.
  const stateAliasIdx = new Map(), stateAliasLooseIdx = new Map();
  for (const a of aliases) {
    if (!a.state) continue;
    if (!stateAliasIdx.has(a.state)) { stateAliasIdx.set(a.state, new Map()); stateAliasLooseIdx.set(a.state, new Map()); }
    stateAliasIdx.get(a.state).set(norm(a.alias), a.team_id);
    stateAliasLooseIdx.get(a.state).set(loose(a.alias), a.team_id);
  }

  // EVERY team a name could mean, across all states — not the last one indexed. `idx`
  // above is last-wins, which is how a global lookup silently picks one of three
  // "Mountain View"s. These keep the ambiguity so a lookup can refuse it.
  const candStrict = new Map(), candLoose = new Map();
  const addCand = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  for (const t of teams) {
    addCand(candStrict, norm(t.name), t.id); addCand(candStrict, norm(t.slug), t.id);
    addCand(candLoose, loose(t.name), t.id); addCand(candLoose, loose(t.slug), t.id);
  }
  for (const a of aliases) { addCand(candStrict, norm(a.alias), a.team_id); addCand(candLoose, loose(a.alias), a.team_id); }

  /** One state only: team name, alias, then the loose forms of both. Never another state. */
  const inState = (name, s) => {
    if (!s) return null;
    return stateIdx.get(s)?.get(norm(name)) ?? stateAliasIdx.get(s)?.get(norm(name))
        ?? stateLooseIdx.get(s)?.get(loose(name)) ?? stateAliasLooseIdx.get(s)?.get(loose(name)) ?? null;
  };

  const slugOf = new Map(teams.map(t => [t.id, t.slug]));
  /** Ruled slugs that name no team: a ruling that cannot match is reported, not ignored. */
  const staleForeignRulings = [...FOREIGN.values()].filter(slug => !teams.some(t => t.slug === slug));
  const staleRuledOut = [...RULED_OUT.values()]
    .filter(r => r.teams.some(slug => !teams.some(t => t.slug === slug)))
    .map(r => `${r.season} ${r.date} ${r.teams.join(' v ')}`);
  /** The ruled-out entry for a game between two of our team ids, or null. */
  const ruledOut = (season, date, idA, idB) => {
    const a = slugOf.get(idA), b = slugOf.get(idB);
    if (!a || !b) return null;                      // a dry-run placeholder is never ruled
    return RULED_OUT.get(ruledOutKey(season, date, a, b)) ?? null;
  };

  /**
   * A RATED team (a row of `code`'s ratings feed) → our team id. THE BOTH-STATES RULE,
   * ruled 2026-11-13. Look the name up in the state LaxNumbers tags the row with AND in
   * the feed's state:
   *   one hit, or the same team twice  → that team
   *   two different teams              → REFUSED as ambiguous; never a pick
   *   none                             → unknown
   * Row-state-first would break Hermiston (a WHSBLA school rostered hermiston_wa that
   * LaxNumbers tags OR); feed-state-first is how Idaho's feed — which lists WA, MT and WY
   * schools — reached the wrong school. Asking both and refusing a disagreement needs
   * neither order. No global fallback and no stateless match: a rated team belongs to a
   * covered state's roster or it is unresolved.
   *
   * A row tagged with ANOTHER state that matches ONLY through the feed's state is a
   * guess unless ruled: it is attached only when data/foreign-row-rulings.json lists it
   * for this feed with that exact team (Idaho's seven Spokane/Montana/Wyoming schools,
   * Hermiston). Otherwise REFUSED as 'foreign-unruled' — unresolved, logged, not created.
   */
  const resolveRated = (t, code) => {
    const rowState = t.state ? String(t.state).trim().toUpperCase() : null;
    const a = rowState ? inState(t.name, rowState) : null;
    const b = rowState === code ? a : inState(t.name, code);
    if (a != null && b != null && a !== b) return { id: null, reason: 'ambiguous', candidates: [a, b], rowState };
    const id = a ?? b;
    if (id == null) return { id: null, reason: 'unknown', rowState };
    const via = a != null ? 'row' : 'feed';
    if (via === 'feed' && rowState && rowState !== code) {
      const ruled = FOREIGN.get(`${code}|${norm(t.name)}`);
      if (ruled !== slugOf.get(id)) {
        return { id: null, reason: 'foreign-unruled', candidates: [id], rowState };
      }
      return { id, rowState, via, ruled: true };
    }
    return { id, rowState, via };
  };

  /**
   * An OPPONENT string on `code`'s team pages → our team id. LaxNumbers publishes no state
   * for an opponent, so: `code`'s own teams and aliases first; then the whole roster ONLY
   * when exactly one team answers to the name (strict first, loose only if strict finds
   * nothing). Several → REFUSED as ambiguous: the last-wins global map picking one of
   * them is the Mountain View defect.
   */
  const resolveOpponent = (name, code) => {
    const local = inState(name, code);
    if (local != null) return { id: local, via: 'state' };
    for (const [m, k] of [[candStrict, norm(name)], [candLoose, loose(name)]]) {
      const set = m.get(k);
      if (!set || set.size === 0) continue;
      if (set.size === 1) return { id: [...set][0], via: 'unique' };
      return { id: null, reason: 'ambiguous', candidates: [...set] };
    }
    return { id: null, reason: 'unknown' };
  };

  /**
   * An OPPONENT on `code`'s team page, by LaxNumbers TEAM NUMBER first (ruled 2026-11-14).
   * `byNbr` is indexRatedByNumber() over every feed fetched this run, Oregon's included.
   *
   *   linked, and the number is in a feed → resolveRated(that row, that feed): the same
   *       both-states rule and foreign-row rulings a rated team gets. A REFUSAL STANDS:
   *       the row is unresolved and the name is NOT tried. The page told us exactly who
   *       the opponent is; a name match that disagrees would be a guess overruling it.
   *       A number carried by more than one feed must resolve to one team in every one.
   *   no link, or a number in none of our feeds → resolveOpponent(name), as before.
   *
   * This is the Borah row: "Mountain View" t=12983 is Oregon's mt_view, which the name
   * rule (Idaho's own teams first) got wrong.
   *
   * `storedOf(feed, nbr)`, when given, is the remembered team for that number
   * (laxnumbers_teams): each hit is checked against it by teams.js identity(), so a
   * renamed opponent still resolves and a disagreement is refused.
   */
  const resolveOpponentGame = (g, code, byNbr, storedOf = null) => {
    const nbr = g.opponentNbr ?? null;
    const hits = nbr != null ? byNbr.get(nbr) : null;
    if (!hits || hits.length === 0) {
      return { ...resolveOpponent(g.opponentRaw, code), by: 'name', nbr,
               nameWhy: nbr == null ? 'no-link' : 'not-in-feeds' };
    }
    const fresh = h => resolveRated(h.row, h.feed);
    const checked = h => storedOf ? identity(fresh(h), storedOf(h.feed, nbr), id => byId.has(id)) : fresh(h);
    const rs = hits.map(h => ({ feed: h.feed, ratedName: h.row.name, ...checked(h) }));
    const refused = rs.find(r => r.id == null);
    const ids = [...new Set(rs.map(r => r.id))];
    if (!refused && ids.length === 1) return { id: ids[0], by: 'number', nbr, feed: rs[0].feed };
    if (refused) return { ...refused, id: null, by: 'number', nbr };
    return { id: null, reason: 'ambiguous', candidates: ids, by: 'number', nbr,
             feed: rs.map(r => r.feed).join('+') };
  };

  return { idx, looseIdx, byId, teamState, stateIdx, stateLooseIdx,
           stateAliasIdx, stateAliasLooseIdx, candStrict, candLoose, addCand,
           inState, resolveRated, resolveOpponent, resolveOpponentGame, staleForeignRulings,
           ruledOut, staleRuledOut };
}

module.exports = { norm, loose, RULINGS, DO_NOT_MERGE, slugify, buildIndexes, loadForeignRowRulings,
                   loadRuledOutGames, indexRatedByNumber };
