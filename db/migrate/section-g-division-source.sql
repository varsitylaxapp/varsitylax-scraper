-- ═══════════════════════════════════════════════════════════════════════════
-- Section G — team_seasons.division_source.
--
-- Closes a real gap: the WHSBLA importer's commit message and README both claim
-- 2026 classifications are marked source='laxnumbers_provisional', but
-- team_seasons had no column to store that in. The provenance was documented
-- and not persisted — the DB could not distinguish a provisional classification
-- from an authoritative one.
--
-- Nullable on purpose: Oregon's 'or_open' is a synthetic single division derived
-- from the schema, not sourced from anywhere external. NULL means exactly that.
--
-- API-safe: /api/v2/teams selects ts.conference, ts.wins, ts.losses explicitly,
-- so a new team_seasons column cannot leak. Re-verified with the 95/95 harness.
ALTER TABLE team_seasons
  ADD COLUMN division_source VARCHAR(32) NULL AFTER division_id;

-- Backfill: every non-Oregon 2026 classification came from the LaxNumbers class
-- pages and is PROVISIONAL. It is nonetheless bracket-validated — see
-- data/whsbla-2026/README.md — so it must not be overwritten by the October
-- WHSBLA final, which supersedes 2027 only.
UPDATE team_seasons ts
   JOIN teams t ON t.id = ts.team_id
    SET ts.division_source = 'laxnumbers_provisional'
  WHERE ts.season = 2026 AND t.state <> 'OR' AND ts.division_source IS NULL;

CREATE INDEX idx_team_seasons_div_source ON team_seasons (season, division_source);
