# Source Data Quirks

Known upstream data defects, their handling, and where the handling lives.
Discovered during the Phase 3 migration (July 2026).

## LaxPower (laxmath.com) — team names truncated to 12 characters

The source page renders names pre-truncated (e.g. `8 . Mountain Vie`). Full names
are unrecoverable from this source; every future scrape reproduces the same 12-char
strings. **Not a scraper bug.**

Handling: permanent `team_aliases` rows with `source = 'laxpower-truncated'`
(10 OR teams whose names exceed 12 chars). Any new team crossing 12 chars in a
future season needs an alias added the same way — an unresolved-name failure in
the rankings pipeline is the signal.

## LaxPower — duplicate team listings

The 2026 season page double-listed Westview at ranks 33 and 34 (same record,
near-identical consensus). The `ranking_entries` PK `(snapshot_id, team_id)`
absorbs duplicates, keeping the first-listed rank. Published rank positions below
a phantom row are inflated by one; we preserve them **as published** rather than
renumbering — the snapshot records what the source said.

## OHSLA — "Team Place Holder" rows

TBD playoff-slot schedule rows with no opponent and no scores (9 rows in 2026,
mostly 2026-05-19). Excluded from the games backfill; logged in
`unresolved_aliases` with context. Scraper v2 should skip these rows at ingest
(match on exact string `Team Place Holder`).

## Legacy vs new schema collation (migration-transient)

Legacy tables (`team_schedules`, `laxnumbers_rankings`, `laxpower_rankings`,
`scrape_log`) are `utf8mb4_general_ci`; Phase 1 tables are `utf8mb4_0900_ai_ci`.
Any query joining across that boundary must CONVERT both sides to a common
collation (see `EQ()` in `db/migrate/section-d-backfill.js`). This applies to
migration scripts only — app/API queries touch one side only. The issue retires
itself when the legacy tables are dropped at E5.5. Do not ALTER either side's
collation to "fix" this.
