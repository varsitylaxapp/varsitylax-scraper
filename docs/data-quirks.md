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

---

## OHSLA never retires a fixture — assume additive-only sources

**Established 2026-07-29.** A fact about the world, worth more than the fix it prompted.

When a game MOVES, ohsla.net adds a row for the new date and **leaves the old one
standing**. When a game is CANCELLED, the row **stands forever**. The feed only ever
grows.

Evidence: nine 2026 fixtures were still `scheduled` and unscored months after the
season ended — and all nine carried `source_updated_at = 2026-07-27 21:02–21:03`,
which *is* the most recent successful `ohsla-v2` scrape. That run touched all 354
games. The source is not forgetting these rows; it is actively re-asserting them.

Worked example, the clearest of the nine:

```
v1 row   marist vs Newberg   2026-05-26 7:00pm   unscored   scraped 2026-05-23
reality  marist vs newberg   2026-05-27 7:00pm   10-11      played
```

Same 7:00pm fixture, moved one day, and OHSLA published both.

### Why this defeats pruning

`src/dual-write.js`'s prune asks: *does this pair+date still appear in the current
feed?* For an additive-only source the answer is permanently yes. The prune is not
missing a rule — **it never gets the chance**. Any design that infers deletion from a
source's silence will fail here, because this source is never silent.

I initially read the nine rows' clustering on 2026-04-10 as one scrape's batch
surviving unreconciled — a process failure. It is not: all nine were created in the
same v1→v2 backfill, and 04-10 is simply a date OHSLA still lists five fixtures for.
A cluster in the DATA is not a cluster in the PROCESS.

### The rule that does work

Staleness must be decided by US, from elapsed time, not inferred from the feed. See
`src/stale-fixtures.js` and `migrations/section-k-stale-fixtures.sql`: no scores +
still `scheduled` + more than 14 days past → `status = 'stale'`. Marked, not deleted,
so a re-assertion lands harmlessly on the marked row and a late score revives it.
`practice` is exempt; a listed, never-scored practice is a true fact.

### Assume the same of WHSBLA until proven otherwise

There is no evidence Sportability behaves better, and the rule applies to both
sources for that reason. `v_stale_watch` surfaces fixtures ageing past 7 days — before
the 14-day mark hides them — because a played-but-unscored game is data-entry lag we
want to see, not bury.
