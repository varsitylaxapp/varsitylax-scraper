-- Section J — forfeit becomes a real column; the "note=" artifact dies
--
-- `status_note` was carrying four distinct things as free text, all with a spurious
-- `note=` prefix from the WHSBLA extractor:
--
--     note=Overtime      29    REDUNDANT — is_overtime already says this
--     note=Forfeit       10    real information with no column
--     note=One Referee    3    officiating detail
--     note=No Referees    1    officiating detail
--
-- OVERTIME NEEDED NO RECONCILIATION. It looked like two sources of truth
-- disagreeing (is_overtime=41 vs note=Overtime=29) and is not: OHSLA supplies 12
-- overtime games and has no notation column at all, WHSBLA supplies 29 and sets BOTH
-- the flag and the note, agreeing on every one. 41 = 12 + 29, zero rows in conflict.
-- `is_overtime` is authoritative for both sources, so the note form is pure
-- duplication and is dropped rather than preserved.
--
-- FORFEIT is the one that mattered: 10 games where the result was awarded rather
-- than played, indistinguishable in the API from a normal result.

-- 1. The column.
ALTER TABLE games
  ADD COLUMN is_forfeit BOOLEAN NOT NULL DEFAULT 0;

-- 2. Backfill from the notes, before they are rewritten.
UPDATE games SET is_forfeit = 1 WHERE status_note = 'note=Forfeit';

-- 3. Drop the redundant overtime note. is_overtime already carries it, and leaving
--    both invites exactly the "which one is right" question that cost time here.
UPDATE games SET status_note = NULL WHERE status_note = 'note=Overtime';

-- 4. Forfeit now lives in a column, so its note is redundant too.
UPDATE games SET status_note = NULL WHERE status_note = 'note=Forfeit';

-- 5. Strip the extractor's prefix from what remains. The officiating notes stay as
--    free text: 4 rows across 856 games does not justify a column, and unlike
--    forfeit they do not change how a result should be read.
UPDATE games
   SET status_note = SUBSTRING(status_note, 6)
 WHERE status_note LIKE 'note=%';

-- 6. Index it: "show me the forfeits" is a data-quality question that will be asked.
ALTER TABLE games
  ADD KEY idx_games_forfeit (season, is_forfeit);
