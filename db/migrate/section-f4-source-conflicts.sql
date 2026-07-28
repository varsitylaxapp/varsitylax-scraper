-- ═══════════════════════════════════════════════════════════════════════════
-- Section F4 — source_conflicts.
--
-- Policy (ruling 2026-07-28): game_source_priority ARBITRATES. When a
-- lower-priority source disagrees with the owner of a field, the value is NOT
-- overwritten — the disagreement is LOGGED here for a human.
--
-- A one-goal score difference between two leagues' books is a question for the
-- leagues, not something this system should silently resolve in either
-- direction. Surfacing it is the job; adjudicating it is not.
CREATE TABLE IF NOT EXISTS source_conflicts (
    id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    game_id        INT UNSIGNED  NOT NULL,
    field          VARCHAR(32)   NOT NULL,
    owner_source   VARCHAR(32)   NOT NULL,   -- higher priority; its value stands
    owner_value    VARCHAR(128)  NULL,
    other_source   VARCHAR(32)   NOT NULL,   -- lower priority; value NOT applied
    other_value    VARCHAR(128)  NULL,
    resolved_at    DATETIME      NULL,
    resolution     VARCHAR(256)  NULL,
    first_seen_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_conflict (game_id, field, other_source),
    KEY idx_conflict_unresolved (resolved_at),
    CONSTRAINT fk_conflict_game FOREIGN KEY (game_id) REFERENCES games (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- WHSBLA joins the priority table. Below OHSLA (100) per ruling: OHSLA remains
-- authoritative for the OR-sourced rows it owns. Above the ranking scrapers,
-- which carry no game data.
INSERT INTO game_source_priority (source, priority, notes) VALUES
  ('whsbla', 90, 'WHSBLA league export (Brandon Fortier) — authoritative for WA')
ON DUPLICATE KEY UPDATE priority = VALUES(priority), notes = VALUES(notes);
