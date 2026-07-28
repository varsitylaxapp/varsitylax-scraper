-- ═══════════════════════════════════════════════════════════════════════════
-- Section F — multi-state keys.  FORWARD.
--
-- Decisions encoded here (agreed 2026-07-27):
--   2b = C  divisions is a real table with is_default; plan naming (or_open).
--           Oregon gets a real division row rather than a magic empty string.
--           The API omits `division` when is_default = 1, which is what keeps
--           Oregon responses byte-identical.
--   2c = 3  Rankings snapshots are STATEWIDE only — one per (source, state,
--           season). Division lives on team_seasons; division-filtered rankings
--           are a JOIN, never a stored column on the snapshot.
--   D4      Slug convention is a SUFFIX (_wa/_id/_az). Convention only, no DDL.
--           Oregon slugs stay bare.
--
-- Scope: schema only. Seeds exactly one row (the or_open division). Promotes no
-- placeholder teams, enables no state.
--
-- Target: STAGING ONLY until the byte-identity diff is approved.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── F1. teams: drop the Oregon default, add permanent region ───────────────
-- DEFAULT 'OR' silently stamps any team inserted without an explicit state —
-- precisely the bug we cannot afford once a second state exists.
ALTER TABLE teams
  MODIFY     state  CHAR(2) NOT NULL,
  ADD COLUMN region VARCHAR(64) NULL AFTER city;

-- uq_teams_slug (slug) stays GLOBALLY unique, deliberately: slug is a
-- standalone identifier in /api/v2/schedule/team/:slug and in the app's
-- RankingEntry.teamId. The D4 suffix convention supplies cross-state
-- uniqueness without forcing every client path to carry state.

-- ── F2. venues: same default removal ───────────────────────────────────────
ALTER TABLE venues
  MODIFY state CHAR(2) NOT NULL;

-- ── F3. divisions (new) — decision 2b = C ──────────────────────────────────
CREATE TABLE IF NOT EXISTS divisions (
    id         VARCHAR(16)      NOT NULL,
    state      CHAR(2)          NOT NULL,
    name       VARCHAR(32)      NOT NULL,
    is_default TINYINT(1)       NOT NULL DEFAULT 0,
    sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY        idx_divisions_state (state),
    UNIQUE KEY uq_divisions_state_name (state, name)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4;

-- Oregon's single implicit division. is_default = 1 is the flag the serializer
-- and the UI both read to suppress division affordances entirely.
INSERT INTO divisions (id, state, name, is_default, sort_order)
VALUES ('or_open', 'OR', 'All', 1, 0)
ON DUPLICATE KEY UPDATE name = VALUES(name), is_default = VALUES(is_default);

-- ── F4. team_seasons: division becomes a real FK, per season ───────────────
-- The pre-existing `division VARCHAR(64) NULL` column has never been written
-- (verified: 100% NULL), so CHANGE COLUMN + narrowing is provably safe.
ALTER TABLE team_seasons
  CHANGE COLUMN division division_id VARCHAR(16) NULL;

UPDATE team_seasons ts
   JOIN teams t ON t.id = ts.team_id
    SET ts.division_id = 'or_open'
  WHERE t.state = 'OR' AND ts.division_id IS NULL;

ALTER TABLE team_seasons
  MODIFY division_id VARCHAR(16) NOT NULL,
  ADD CONSTRAINT fk_team_seasons_division
      FOREIGN KEY (division_id) REFERENCES divisions (id)
      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX idx_team_seasons_division ON team_seasons (season, division_id);

-- ── F5. team_aliases: state-scoped uniqueness  ◀── THE BLOCKER ─────────────
-- uq_team_aliases_normalized(alias_normalized) is globally unique, so one
-- normalized name maps to one team across ALL states. Oregon already owns
-- 'mountain view' (section-c-seed.js mt_view aliases); WA's Mountain View was
-- hand-renamed to 'Mountain View (WA)' in a7-classification.json purely to dodge
-- this key. A real WA feed returns the bare string and would resolve to Oregon.
--
-- state is denormalized from teams.state — MySQL cannot generate a column from
-- another table. Kept in sync by the seed scripts; drift is asserted by the
-- verify script.
ALTER TABLE team_aliases
  ADD COLUMN state CHAR(2) NOT NULL DEFAULT 'OR' AFTER team_id;

UPDATE team_aliases ta
   JOIN teams t ON t.id = ta.team_id
    SET ta.state = t.state;

ALTER TABLE team_aliases
  MODIFY state CHAR(2) NOT NULL;            -- MODIFY without DEFAULT drops it

ALTER TABLE team_aliases
  DROP INDEX uq_team_aliases_normalized,
  ADD  UNIQUE KEY uq_team_aliases_state_normalized (state, alias_normalized);

-- ── F6. rankings_snapshots: state scope (statewide only — decision 2c = 3) ──
-- No `division` column: LaxNumbers publishes one list per state, and per
-- decision 2c the class pages are a seeding input, not a ranking attribute.
ALTER TABLE rankings_snapshots
  ADD COLUMN state CHAR(2) NOT NULL DEFAULT 'OR' AFTER source;

ALTER TABLE rankings_snapshots
  MODIFY state CHAR(2) NOT NULL;

ALTER TABLE rankings_snapshots
  DROP INDEX uq_snapshot,
  ADD  UNIQUE KEY uq_snapshot (source, state, season, captured_at);

-- ranking_entries needs NO change: keyed by snapshot_id, so it inherits state.

-- ── F7. unresolved_aliases: per-state ──────────────────────────────────────
ALTER TABLE unresolved_aliases
  ADD COLUMN state CHAR(2) NOT NULL DEFAULT 'OR' AFTER source;

ALTER TABLE unresolved_aliases
  MODIFY state CHAR(2) NOT NULL;

ALTER TABLE unresolved_aliases
  DROP INDEX uq_unresolved,
  ADD  UNIQUE KEY uq_unresolved (raw_name, source, state);

-- ── F8. scrape_log: per-state ──────────────────────────────────────────────
-- Source strings stay byte-identical ('laxnumbers', 'laxnumbers-v2', 'ohsla');
-- the column disambiguates, so v1 /health stays Oregon-scoped and a non-Oregon
-- failure can never mask an Oregon success.
ALTER TABLE scrape_log
  ADD COLUMN state CHAR(2) NOT NULL DEFAULT 'OR' AFTER source;
-- DEFAULT retained here only: scrape_log is append-only telemetry, and a missing
-- state should degrade to Oregon rather than reject the insert.

-- ── games: NO CHANGE, deliberately ─────────────────────────────────────────
-- A game's state derives from its two team FKs. Adding a state column would
-- force the OR-vs-WA ownership question, which is a schedule concern and is
-- explicitly out of scope. The same-day doubleheader/rematch gap in uq_game
-- remains a tracked design-together item.
