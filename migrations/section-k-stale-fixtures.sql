-- Section K — `stale` status for fixtures the source never retires
--
-- THE FACT ABOUT THE WORLD (see docs/data-quirks.md): OHSLA never retires a fixture.
-- A moved game gets a NEW row and the old one stands. A cancelled game stands
-- forever. The most recent scrape (2026-07-27 21:03) re-confirmed all nine of the
-- 2026 season's orphan `scheduled` rows, months after the season ended.
--
-- So the prune cannot help. Its predicate asks "does the source still list this
-- pair+date" and the honest answer is yes. Downstream systems must assume
-- ADDITIVE-ONLY sources and decide staleness themselves.
--
-- THE RULE: a game with no scores, still `scheduled`, more than 14 days past its
-- date, is not a real fixture. Marked `stale`.
--
-- WHY 'stale' AND NOT 'cancelled'. The enum already offers `cancelled` and
-- `postponed`, both unused. Neither is honest here: we do not know the game was
-- cancelled. We know the source still lists it and nobody ever scored it. `stale`
-- names our epistemic state rather than asserting a fact about the fixture.
--
-- WHY MARKING AND NOT DELETING — three reasons, all about what happens NEXT:
--   1. the feed re-asserting the row is harmless. The upsert lands on the marked row
--      instead of resurrecting a deleted one.
--   2. a late score auto-revives it. Scores flow through the same upsert, which sets
--      status from the score's presence; `stale` gates DISPLAY, not truth.
--   3. a played-but-unscored game ageing past 14 days is DATA-ENTRY LAG, which we
--      want surfaced, not buried. Hence the ops view below.
--
-- Records are unaffected either way: `v_team_season_record` already requires
-- `status = 'completed'`, and a stale row has no scores to count.

ALTER TABLE games
  MODIFY COLUMN status ENUM('scheduled','completed','cancelled','postponed','stale')
    NOT NULL DEFAULT 'scheduled';

-- Ops visibility. "Which fixtures are ageing out unscored" is an in-season
-- data-entry-lag question, and the answer must be a glance, not an archaeology
-- session. Deliberately includes rows NOT yet stale (7+ days) so lag is visible
-- BEFORE the 14-day mark hides them.
CREATE OR REPLACE VIEW v_stale_watch AS
SELECT g.id,
       g.season,
       g.game_date,
       DATEDIFF(CURDATE(), g.game_date)          AS days_past,
       g.status,
       g.game_type,
       g.canonical_source,
       ht.slug  AS home_slug,
       ht.state AS home_state,
       at2.slug AS away_slug,
       at2.state AS away_state,
       CASE WHEN g.status = 'stale' THEN 'marked stale'
            ELSE 'ageing — not yet stale' END     AS disposition
  FROM games g
  JOIN teams ht  ON ht.id  = g.home_team_id
  JOIN teams at2 ON at2.id = g.away_team_id
 WHERE g.home_score IS NULL
   AND g.away_score IS NULL
   AND g.status IN ('scheduled', 'stale')
   AND g.game_type <> 'practice'          -- a listed, never-scored practice is a true fact
   AND g.game_date < CURDATE() - INTERVAL 7 DAY
 ORDER BY g.game_date;

-- Escape hatch for genuine exceptions, same pattern as alias-decisions.json's
-- do_not_merge: a human ruling that survives re-scraping. STARTS EMPTY, and should
-- stay empty unless a real fixture is being wrongly aged out.
CREATE TABLE IF NOT EXISTS stale_exemptions (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  season       SMALLINT UNSIGNED NOT NULL,
  team_lo      INT UNSIGNED NOT NULL,
  team_hi      INT UNSIGNED NOT NULL,
  game_date    DATE NOT NULL,
  reason       VARCHAR(255) NOT NULL,
  approver     VARCHAR(64)  NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stale_exemption (season, team_lo, team_hi, game_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
