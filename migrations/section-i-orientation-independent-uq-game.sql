-- Section I — make uq_game orientation-independent
--
-- WHY. `uq_game (season, home_team_id, away_team_id, game_date)` is
-- orientation-sensitive: (home=nelson, away=richland) and (home=richland,
-- away=nelson) hash to different keys, so the constraint permitted BOTH. Six
-- cross-source games were duplicated that way — every one a game where OHSLA and
-- WHSBLA disagree about who was home — inflating four team records and rendering
-- six games twice on two Scores boards. See scripts/dedupe-mirrored-games.js,
-- which collapsed them and logged each orientation disagreement to
-- source_conflicts rather than silently picking a side.
--
-- The unique key now uses a canonical unordered pair: least/greatest of the two
-- team ids, as STORED GENERATED columns so the index is over real values rather
-- than an expression.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ WHAT THIS DECIDES: SAME-DAY HOME-AND-HOME IS NOW UNREPRESENTABLE
--
-- The long-tracked doubleheader gap formally narrows here. Two teams playing each
-- other TWICE on ONE DATE — a home-and-home pair, one game at each venue — becomes
-- impossible to store: both rows canonicalise to the same (season, pair, date) key
-- and the second is rejected.
--
-- Accepted deliberately, on evidence: the 2026 data contains ZERO such cases
-- (verified 2026-07-29 across all 862 games — the only same-day repeat pairs were
-- the six mirrored duplicates this migration exists to prevent, which are one game
-- recorded twice, not two games).
--
-- The alternative — leaving the key orientation-sensitive so a hypothetical
-- doubleheader fits — is what allowed six real duplicates and four wrong records.
-- A constraint that admits today's actual corruption to accommodate a fixture type
-- nobody has scheduled is the wrong trade.
--
-- WHEN THE DOUBLEHEADER DESIGN HAPPENS it needs a discriminator in the key — a
-- sequence number or a venue id — not the removal of this constraint. Reverting to
-- orientation-sensitivity would reopen exactly this bug.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Canonical unordered team pair, stored so it can be indexed.
--
--    VIRTUAL, not STORED, and this is not a style preference. A STORED generated
--    column forces a full table rebuild, and rebuilding `games` fails outright with
--    "Cannot add foreign key constraint" — it carries four FKs (home_team_id,
--    away_team_id, canonical_source, venue_id) that cannot all be recreated during
--    the copy. VIRTUAL adds the column in place, and MySQL 8+ indexes virtual
--    columns perfectly well, which is all this needs.
--
--    Note this differs from teams.alias_normalized, which IS stored. That one is
--    read directly and often; these two exist only to be indexed.
--
--    No AFTER clause either: column position is cosmetic and specifying it
--    reintroduces the rebuild.
ALTER TABLE games
  ADD COLUMN team_lo INT UNSIGNED
    GENERATED ALWAYS AS (LEAST(home_team_id, away_team_id)) VIRTUAL;

ALTER TABLE games
  ADD COLUMN team_hi INT UNSIGNED
    GENERATED ALWAYS AS (GREATEST(home_team_id, away_team_id)) VIRTUAL;

-- 2. Swap the key. Dropping first is required: the old key would otherwise keep
--    admitting mirrored pairs that the new one rejects, and having both is a
--    contradiction rather than belt-and-braces.
ALTER TABLE games DROP INDEX uq_game;

ALTER TABLE games
  ADD UNIQUE KEY uq_game (season, team_lo, team_hi, game_date);

-- 3. An index on the old shape is still wanted for lookups by home team, which the
--    dropped unique key was incidentally serving.
ALTER TABLE games
  ADD KEY idx_games_home_date (season, home_team_id, game_date);
