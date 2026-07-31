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

---

## Real brackets are not balanced, and `play_in_games` cannot describe them

Discovered while validating `/schedule/playoffs`'s new `round` field against what a
textbook single-elimination bracket should look like. My expectation was wrong; the data
is right.

All six 2026 brackets ARE clean single elimination — verified structurally, not assumed:
every team loses at most once, distinct teams == games + 1, and every game's two slots
are accounted for by either a team entering the bracket or a feeder's winner. Zero
malformed games across 81 playoff games.

But the trees are **lopsided**, and two of them are lopsided in a way arithmetic on
`field_size` cannot express:

| bracket | field | `play_in_games` | max round | teams enter at |
|---|---|---|---|---|
| cascade_cup | 16 | 0 | 3 | r3: 16 — perfectly balanced |
| championship | 24 | 8 | 4 | r4: 16, r3: 8 |
| wa_3a | 9 | 1 | 3 | r3: 2, r2: 7 |
| wa_2a | 5 | 1 | 2 | r2: 2, r1: 3 |
| **wa_private** | **16** | **0** | **4** | r4: 4, r3: 10, **r2: 2** |
| **wa_4a** | **17** | **1** | **5** | r5: 2, r4: 3, r3: 10, **r2: 2** |

`wa_private` has a field of 16 — a power of two, so `play_in_games` computes to 0 — yet
it plays two preliminary games and byes two teams straight to the quarterfinals. `wa_4a`
reaches depth 5 where a balanced 17-team field maxes at 4. `play_in_games` is
`field_size - 2^floor(log2(field_size))`; it assumes the only irregularity is a single
play-in column, and for these two that assumption is false.

### Consequence for the client, and the reason `round` is server-shipped

**Never compute bracket layout from `field_size` and `play_in_games`.** Lay columns out
from the maximum `round` actually present, and place each game at its own `round`. A
client doing the arithmetic would have drawn 4A and PV/Open with the wrong number of
columns and every cell in the wrong one — which is precisely the class of error that
`buildBrackets` reconstructing a field from rankings belonged to.

The two stored numbers keep their jobs: `field_size` is how many teams qualified (17 of
4A's 27, so it can never come from division membership), and `play_in_games` is a
declared property of the format that the seeder cross-checks. Neither is a layout
instruction.

### Byes are an absence, never a row

A bye is a team whose first game is at a shallower round than the bracket's deepest —
`wa_private`'s two quarterfinal entrants. Nothing in `playoff_formats` or
`/schedule/playoffs` represents one, and nothing should: the absence of a round-3 game
for that team *is* the bye. See `scripts/test-playoff-graph.js`, which asserts no
placeholder game is invented.

---

## LaxNumbers and Cloudflare: the client matters more than the vantage

`www.laxnumbers.com` sits behind Cloudflare, and whether a request is served depends on
the **header set**, not on where it comes from.

The scraper's axios calls — which send `Accept`, `Accept-Encoding` and `Connection` by
default alongside the explicit `User-Agent` and `Referer` — are served from a developer
machine and from the Railway container alike. A hand-written `curl` with only those two
explicit headers gets **403 and a Cloudflare interstitial for every path**, including the
one production scrapes successfully every two hours.

**So neither local success nor local failure is evidence about the source.** On 2026-07-30
a feasibility probe concluded LaxNumbers was blocking this machine, on the strength of
Oregon's known-good endpoint 403ing too — a control that controlled for nothing, because
both requests came from the same wrong client. The scraper module reached all five states
immediately.

**Probe through `src/scrapers/laxnumbers.js`, never through ad-hoc curl.** If a raw
request is unavoidable, copy axios's default headers rather than the two the code names
explicitly. Cloudflare's posture also drifts over time, so a result from either client is
worth re-checking rather than remembering.
