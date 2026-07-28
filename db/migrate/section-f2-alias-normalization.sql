-- Section F2 — fold hyphen/space equivalence into alias_normalized.
--
-- Makes 'Graham-Kapowsin' and 'Graham Kapowsin' resolve to the same key, so that
-- class of match never needs a human again.
--
-- NARROW RULE ONLY (hyphen -> space). Verified on staging 2026-07-28:
--   hyphen-only folding          -> 0 collisions   (safe)
--   full punctuation folding     -> 34 collisions  (ALTER would FAIL)
-- alias_normalized is STORED GENERATED and participates in
-- uq_team_aliases_state_normalized, so MySQL re-evaluates every row on ALTER and
-- any duplicate aborts the migration.
--
-- KNOWN MISS, accepted: a hyphen with surrounding spaces ('Aloha - Southridge')
-- becomes 'aloha   southridge' and still will not match 'Aloha Southridge'.
-- Closing that needs whitespace collapsing, which is exactly what produces the
-- 34 collisions. Tracked follow-up, gated on proving no collision group spans
-- two DIFFERENT teams.
ALTER TABLE team_aliases
  MODIFY alias_normalized VARCHAR(128)
    GENERATED ALWAYS AS (REPLACE(LOWER(TRIM(alias)), '-', ' ')) STORED NOT NULL;
