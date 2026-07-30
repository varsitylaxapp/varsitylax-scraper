-- Section L — PlayoffFormat as data
--
-- Bracket SHAPE is seeded data; game→bracket ASSIGNMENT is derived from the game
-- graph; QUALIFICATION comes from the games themselves. Nothing here is derived from
-- rankings or from team membership, and both exclusions are load-bearing:
--
--   RANKINGS was the accident that made Oregon's bracket "work". buildBrackets
--   reconstructed a 24-team field by taking conference auto-qualifiers plus at-large
--   from the LaxNumbers table — so the bracket rendered correctly only for as long as
--   the rankings happened to reproduce the real field, and it could not render
--   Washington at all.
--
--   TEAM MEMBERSHIP is not merely wrong, it is ill-formed. Oregon's Cascade Cup is
--   fed by Championship first-round losers, so `newberg` legitimately appears in BOTH
--   brackets. "Which bracket is this team in" has no answer. Games partition; teams
--   do not. That is the deep reason bracket identity lives on the game graph.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ANCHORS ARE NATURAL KEYS, NOT game_id.
--
-- Each bracket is anchored at its FINAL, identified by (game_date + unordered team
-- pair) and resolved to a game id at load time. NOT by id, because ids are
-- environment-local and re-import-mutable: staging's ids already differ from what
-- prod will hold after stage (c), and this project has twice destroyed ids in place
-- (the mirrored-game dedupe deleted six; the v1→v2 backfill renumbered everything).
-- A format seeded with staging ids breaks the day it ships.
--
-- Resolution failure — no game matching the key — is a LOUD STOP, never a fallback.
-- It doubles as the canary for a final being rescheduled: if the anchor stops
-- resolving, the tournament changed shape and a human should look.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS playoff_formats (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  season         SMALLINT UNSIGNED NOT NULL,
  state          CHAR(2) NOT NULL,
  -- NULL = statewide bracket (Oregon's Championship and Cascade Cup both span the
  -- whole state). Non-null = one bracket per division (Washington).
  -- VARCHAR because divisions.id is a STRING key ('or_open', 'wa_4a', 'wa_private'),
  -- not an integer. Spencer's "wa_private" was right and my "correction" to PV/Open
  -- was wrong: wa_private is the ID, PV/Open is the display NAME.
  division_id    VARCHAR(16) NULL,
  -- Stable machine key. Unique per (season, state), which lets the unique index skip
  -- division_id entirely and avoids MySQL's "NULLs never compare equal" trap.
  bracket_key    VARCHAR(40) NOT NULL,
  display_name   VARCHAR(60) NOT NULL,
  -- Teams in the FIELD, which is not the division's population: 17 of 4A's 27 teams
  -- qualified in 2026. Qualification is data, never derived from membership.
  field_size     SMALLINT UNSIGNED NOT NULL,
  -- Games in the optional play-in column that reduces the field to a power of two.
  -- Stored rather than computed so a format that deviates can say so; the seeder
  -- asserts it equals field_size - 2^floor(log2(field_size)).
  play_in_games  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- The anchor: this bracket's final, by natural key.
  final_date     DATE NOT NULL,
  final_slug_lo  VARCHAR(64) NOT NULL,   -- the pair, sorted, so orientation cannot matter
  final_slug_hi  VARCHAR(64) NOT NULL,
  sort_order     SMALLINT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_playoff_format (season, state, bracket_key),
  KEY idx_playoff_format_lookup (season, state, sort_order),
  CONSTRAINT fk_playoff_format_division FOREIGN KEY (division_id) REFERENCES divisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Resolved anchors, for a consumer that wants the id without redoing the lookup.
-- A format whose anchor does not resolve is ABSENT here rather than present-with-null,
-- so "SELECT ... JOIN" naturally excludes broken formats and a count mismatch against
-- playoff_formats is the alarm.
CREATE OR REPLACE VIEW v_playoff_format_anchors AS
SELECT pf.id            AS format_id,
       pf.season,
       pf.state,
       pf.division_id,
       pf.bracket_key,
       pf.display_name,
       pf.field_size,
       pf.play_in_games,
       pf.sort_order,
       g.id             AS final_game_id,
       g.game_date      AS final_game_date
  FROM playoff_formats pf
  JOIN teams t1 ON t1.slug = pf.final_slug_lo
  JOIN teams t2 ON t2.slug = pf.final_slug_hi
  JOIN games g
    ON g.season = pf.season
   AND g.game_date = pf.final_date
   AND LEAST(g.home_team_id, g.away_team_id)    = LEAST(t1.id, t2.id)
   AND GREATEST(g.home_team_id, g.away_team_id) = GREATEST(t1.id, t2.id);
