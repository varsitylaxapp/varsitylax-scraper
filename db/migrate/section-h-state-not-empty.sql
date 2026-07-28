-- ═══════════════════════════════════════════════════════════════════════════
-- Section H — CHECK (state <> '') on the two tables old//careless writers touch.
--
-- WHY THIS EXISTS. Production runs sql_mode = NO_ENGINE_SUBSTITUTION — NO
-- STRICT. Staging and the 8.0.41 rehearsal instance both had STRICT, so the
-- rehearsal could not surface this: identical MySQL version, different mode.
--
-- Consequence discovered during the 2026-07-28 prod window: an INSERT omitting
-- `state` does NOT raise ERROR 1364 on prod. It silently writes state = ''.
-- And because every read filters `AND state = ?`, such a row is INVISIBLE to
-- the API — rankings would appear frozen while scrape_log reported success.
-- That is the silent-success failure class, again.
--
-- CHECK constraints are enforced by MySQL 8.0.16+ independently of sql_mode,
-- so this restores loud failure on a non-strict host. Belt; the db.js SESSION
-- sql_mode change is the braces.
--
-- Safe to apply with the new code running: it always supplies `state`.
ALTER TABLE rankings_snapshots
  ADD CONSTRAINT chk_rankings_snapshots_state_nonempty CHECK (state <> '');

ALTER TABLE unresolved_aliases
  ADD CONSTRAINT chk_unresolved_aliases_state_nonempty CHECK (state <> '');
