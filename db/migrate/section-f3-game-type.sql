-- ═══════════════════════════════════════════════════════════════════════════
-- Section F3 — game_type + location as real columns.
--
-- Replaces the status_note packing stopgap ("type=Playoff; loc=Starfire").
-- Standings math must key off a column, never string-parsing.
--
-- BYTE-IDENTITY CONTRACT: these columns must NOT surface in any API response.
-- api-v2.js selects an explicit column list (GAME_SELECT) and gameJson() builds
-- an explicit object, so new columns cannot leak. Proven by re-running the
-- 95/95 Oregon capture diff around this migration.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE games
  ADD COLUMN game_type ENUM('league','non_league','playoff','exhibition','practice')
      NOT NULL DEFAULT 'league' AFTER is_scrimmage,
  ADD COLUMN location VARCHAR(128) NULL AFTER venue_id;

-- Backfill preserves existing Oregon semantics EXACTLY:
--   is_scrimmage = 1  ->  exhibition   (the only scrimmage flavour OHSLA has)
--   is_conference = 1 ->  league
--   otherwise         ->  non_league
UPDATE games SET game_type = CASE
    WHEN is_scrimmage  = 1 THEN 'exhibition'
    WHEN is_conference = 1 THEN 'league'
    ELSE 'non_league'
  END;

CREATE INDEX idx_games_type ON games (season, game_type);

-- Standings math now excludes via the column instead of is_scrimmage.
--
-- SCOPE NOTE: this view computes the OVERALL win-loss record shown on team
-- pages, so it excludes only exhibition and practice. Because the backfill maps
-- is_scrimmage 1:1 onto exhibition, the result set is bit-for-bit what it was
-- before this migration — Oregon records do not move.
--
-- It deliberately does NOT exclude non_league: for Oregon, non-conference games
-- have always counted toward the overall record, and excluding them here would
-- silently rewrite every Oregon team's W-L. League-only standings (which DO
-- exclude non_league) are a separate concept and need their own view.
CREATE OR REPLACE VIEW v_team_season_record AS
SELECT team_id, season,
    SUM(CASE WHEN my_score > opp_score THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN my_score < opp_score THEN 1 ELSE 0 END) AS losses
FROM (
    SELECT home_team_id AS team_id, season, home_score AS my_score, away_score AS opp_score
    FROM games
    WHERE status = 'completed' AND game_type NOT IN ('exhibition','practice')
      AND home_score IS NOT NULL AND away_score IS NOT NULL
    UNION ALL
    SELECT away_team_id AS team_id, season, away_score AS my_score, home_score AS opp_score
    FROM games
    WHERE status = 'completed' AND game_type NOT IN ('exhibition','practice')
      AND home_score IS NOT NULL AND away_score IS NOT NULL
) g
GROUP BY team_id, season;
