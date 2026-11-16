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

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE STATEMENT, SO IT CANNOT HALF-APPLY (rewritten 2026-11-15 for window #6)
--
-- This was five ALTERs. MySQL commits every DDL statement on its own, so a failure
-- part-way left a half state, and the likeliest failure is the worst one: with a
-- mirrored duplicate present, statements 1–3 succeed and the ADD UNIQUE KEY fails,
-- leaving team_lo/team_hi added and NO uq_game at all — no duplicate guard of any kind.
-- Rehearsed on prod's 8.4.11 against the 2026-11-15 dump: exactly that.
--
-- A single ALTER TABLE on InnoDB is atomic (MySQL 8 atomic DDL): it either completes
-- or leaves the table as it was. Rehearsed the same way: with the duplicate present it
-- fails with ER_DUP_ENTRY and SHOW CREATE TABLE is unchanged; without it, the result is
-- identical to what the five statements produced.
--
-- ALGORITHM = COPY, stated, because INPLACE refuses this statement: "INPLACE ADD or DROP
-- of virtual columns cannot be combined with other ALTER TABLE actions". COPY rebuilds
-- `games` (1328 rows: 0.13 s in the rehearsal), blocking writes, not reads, while it
-- runs. All four foreign keys survive the rebuild (checked by the rehearsal).
--
-- VIRTUAL, not STORED. These two columns exist only to be indexed. (An earlier STORED
-- attempt failed during its rebuild with "Cannot add foreign key constraint".) No AFTER
-- clause: column position is cosmetic.
--
-- What it does:
--   * team_lo / team_hi: the canonical unordered team pair.
--   * uq_game is dropped and re-added over (season, team_lo, team_hi, game_date). Both
--     keys at once would be a contradiction: the old one admits mirrored pairs.
--   * idx_games_home_date keeps lookups by home team fast; the dropped unique key had
--     been serving them incidentally.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE games
  ADD COLUMN team_lo INT UNSIGNED
    GENERATED ALWAYS AS (LEAST(home_team_id, away_team_id)) VIRTUAL,
  ADD COLUMN team_hi INT UNSIGNED
    GENERATED ALWAYS AS (GREATEST(home_team_id, away_team_id)) VIRTUAL,
  DROP INDEX uq_game,
  ADD UNIQUE KEY uq_game (season, team_lo, team_hi, game_date),
  ADD KEY idx_games_home_date (season, home_team_id, game_date),
  ALGORITHM = COPY;
