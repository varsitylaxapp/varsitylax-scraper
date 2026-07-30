# Backlog

Deferred work with its reasoning attached, so a decision isn't re-litigated or a
fact re-derived. Items leave this file only by being built or explicitly dropped.

---

## Coaches as a feature — additive API release

**Deferred 2026-07-29** during the MockData severance (P2 item 5).

`TeamDetailView` rendered `headCoach` / `asstCoaches`, sourced from `MockData`.
Across all 41 Oregon teams exactly **one** had real data; the other 40 were
`"TBD"`. Adding coaches to `/v2/teams` to serve one team did not justify a
payload change, so the coach block was dropped from the view.

### The data is NOT lost

It already lives in the production schema, seeded during Section C with
`source = 'mockdata'`:

```
team_coaches ⋈ coaches ⋈ teams        (season 2026)

  mt_view   Charles Raub     head
  mt_view   John McGuire     assistant
  mt_view   Kyle Cardinal    assistant
  mt_view   Mason Ludwig     assistant
```

Tables `coaches`, `team_coaches` exist and are populated. Nothing needs
re-entering; the feature needs a payload and a UI, not a migration.

### When to build it

When coach data exists at scale — a league export carrying coaching staff, or a
deliberate data-entry pass. Not before: a feature that renders for 1 team in 41
reads as broken.

### How

Additive mini-release under the byte-identity policy:

- extend `/api/v2/teams` with a `coaches` array (`{ name, role }`), **appended
  last**, and **omitted entirely when empty** — so Oregon's payload does not move
  for the 40 teams that have none, exactly as `division` behaves today
- prove it with `scripts/payload-diff.js` — additions only, nothing removed,
  nothing reordered
- restore the coach block in `TeamDetailView`, hidden when the array is absent

---

## v1 opponent display names — accepted regression

**Accepted 2026-07-29** as part of deleting the client-side identity layer.

`DataService.resolve()` / `displayName()` mapped raw scraped opponent strings to
MockData's curated names — only on the **v1 fallback path**, since v2 carries a
canonical `slug` and `name`. Deleting the identity layer means a v1 response now
renders the raw OHSLA string:

```
  v2 (normal path)   "Bend/Caldera"      ← unchanged, canonical
  v1 (fallback only) "Bend - Caldera"    ← was "Bend/Caldera" via MockData
```

Accepted because v1 is **Oregon-only and sunsetting** — the app already carries
`V1_SUNSET_DATE`, and the fallback fires only when v2 is unreachable. Paying a
cosmetic cost on a near-dead path is the right price for removing a bundled
identity source that was active on *every* path, including healthy ones.

Retires itself when v1 does. No action needed.

---

## Rankings trend arrows — additive backend release, before March 2027

**Deferred 2026-07-29**, found during the design-spec reconciliation.

`docs/design-spec-2027.html` specifies trend arrows as a rankings convention:
`▲n` / `▼n` / `—`. **The client side is already built and shipping** — and inert,
because every server row sets the value to zero.

### What exists on the client

```swift
// RankingEntry
let trend: Int

// RankingRow.trendBadge — exactly the spec's convention, including colours
trend > 0  →  "▲\(trend)"        .appWin      (#00C853)
trend < 0  →  "▼\(abs(trend))"   .appLoss     (#FF6259)
trend == 0 →  "—"                .textMuted   (tertiary)
```

Both production sources — `fetchLaxNumbers` and `fetchLaxPower` — pass a literal
`trend: 0`, so every row in the app renders "—" and always has.

**Inert-safe is proven, not assumed**: the preview fixtures carry `trend: 1` and
`trend: -1`, so the up and down arrows are exercised and render. Nothing about the
arrows is speculative; only the data is missing.

### Why not now

Every trend would be `0` in the offseason. There is no previous-snapshot delta to
compute until rankings actually move week to week, so building it now would ship a
column that is provably a no-op and unverifiable against real movement.

### Why it matters by March 2027

The first in-season Tuesday ranking swing is exactly when parents open the app
twice a day. A rankings table that shows *movement* answers "did we go up?" without
the reader having to remember last week's number. That is the moment the column
earns its width — and it is a moment that arrives on a schedule, not on demand.

### How

Additive mini-release under the byte-identity policy:

- server computes each entry's rank delta against the **previous rankings
  snapshot** for the same `(source, season, state)` and ships it as `trend` per
  entry, **appended last**
- rank IMPROVEMENT is positive: moving #5 → #3 is `trend: +2`. The client already
  reads it that way (`▲` for `> 0`), so getting the sign backwards would render
  every rise as a fall
- first snapshot of a season has no predecessor — omit the key or send `0`, both of
  which the client renders as "—"
- prove with `scripts/payload-diff.js`: additions only, nothing removed or
  reordered, then reset the capture baseline
- **zero client change required.** No App Store release. The arrows light up the
  first time the field arrives non-zero.

### Watch for

`snapshots` needs enough history for a delta to exist. Confirm the retention and
cadence before building: two snapshots a week apart is the minimum useful state,
and a single snapshot per season makes the feature silently permanent-"—".

---

## Live brackets during a season in progress — before March 2027

`src/playoff-graph.js` states this is "tracked, not today's". It was not tracked; this
section is that claim being made true.

### What works today and why it is not enough

The graph assembles a **finished** bracket. Edges are winner-advancement edges, so a game
needs a score before it has one. Feed it a tournament mid-flight and it returns the
played prefix and nothing else: the semifinal that has not happened is not a null cell
waiting to be filled, it is simply absent, because no edge reaches it. Every playoff
game of 2026 is complete, which is why this has never mattered and why it will matter
on the first Saturday of the 2027 playoffs.

### The trap, proven by 2026 data — do NOT compute the empty shape

The obvious fix is to pre-draw the empty bracket from `field_size` and `play_in_games`
and let results fill it in. **That cannot work, and 2026 already disproves it.**

`wa_private` has a field of 16 — a power of two, so `play_in_games` is 0 by arithmetic —
and it still played two preliminary games and byed two teams straight to the
quarterfinals. `wa_4a` reached depth 5 where a balanced 17-team field maxes at 4. A
power-of-two field does not imply a balanced tree, and no arithmetic on field size
recovers the real shape. See the table in `docs/data-quirks.md`.

So empty-bracket structure must come from **the league's published bracket**, seeded into
`playoff_formats` as explicit round structure — how many games at each round, and which
slots feed which — never computed. This is the same rule the renderer already follows for
completed brackets (columns from the max `round` present, cells from their own `round`,
shape data as metadata rather than layout arithmetic); the live case just needs the
structure to exist before the results do.

### Shape of the work

- Extend `playoff_formats` with declared round structure, seeded from the published
  bracket rather than derived. The existing `field_size` / `play_in_games` stay what they
  are — qualification facts and a declared property the seeder cross-checks — and neither
  becomes a layout input.
- `assignBrackets` gains the ability to place a scheduled, unscored game into its
  declared slot, so a cell can exist before it has a winner.
- The renderer's quiet-dash rule already covers a past-dated scheduled game; a
  *future*-dated one in a declared slot is the new state.
- Anchoring stays natural-key. A final that has not been played yet has no game to
  resolve to, so the anchor's stop-and-report needs a "not yet" that is distinct from
  "the final moved" — the current loud failure is correct for a finished season and
  wrong for a live one.

### Watch for

The 2026 brackets are the regression suite for any of this: whatever ships must still
partition OR 38/38 and WA 43/43 with zero orphans and zero overlaps, and still produce
the lopsided trees rather than tidy balanced ones.

---

## Seeds and auto-qualifier status as DATA — candidate, post-launch

Oregon users used to see a seed number on every bracket team, an AUTO pill on conference
auto-qualifiers, and a BYE pill on seeds 1–8. P6 removed all three when `buildBrackets`
died.

**The information was real; its derivation was not.** The client computed seeds by
ordering the LaxNumbers rankings and inferred auto-qualifiers by taking the top-ranked
team in each conference. That reproduced the true field only for as long as the rankings
happened to agree with it, could not run outside Oregon, and is the same class of error
as computing bracket layout from `field_size`. Removing it was correct. Losing what it
displayed was a real cost to Oregon users, and this is the entry that says so.

### The right way, if it comes back

Seeds and auto-qualifier status are **league-published facts**, exactly like a bracket's
field size and its final. They belong in `playoff_formats` (or a child table keyed to it)
as seeded data, resolved by natural key, and rendered as cell adornments.

ENRICHMENT, NEVER DERIVATION. The adornment hangs off a game cell that the graph already
placed; it must not influence which bracket a game belongs to, which column it sits in,
or which cell feeds which. If a seed is missing the cell renders without it — the same
way a missing conference renders no chip rather than an "Unknown" bucket.

### Do not build this pre-emptively

The decision is **how the new screen actually feels on-device**, not a pre-emptive
restoration of what was there. A bracket tree shows the shape of a tournament in a way a
list of round cards could not; seed numbers may turn out to be noise on it, or may turn
out to be exactly what is missing. Spencer's P7 device session is the input. Deciding
before then would be rebuilding from memory of a screen whose generating logic was
condemned.

---

## Swift modernization — deferred past 2.0

Two things that want the same effort, deliberately NOT done before TestFlight.

### `@Observable` instead of `ObservableObject` / `@Published`

Six ViewModels. Available since the iOS 17.0 floor (2026-07-30). Less boilerplate and
finer-grained invalidation — SwiftUI tracks the properties a view actually reads instead
of republishing the whole object.

**Deferred because it touches every screen and buys a user nothing.** Days before a
release is the wrong time to change how every view observes its state; the risk is
entirely on our side of the ledger and the reward is entirely on ours too.

### Swift 6 concurrency warnings

Eight, all the same shape:

```
main actor-isolated static property 'pacificTimeZone' can not be referenced from a
nonisolated context; this is an error in the Swift 6 language mode
```

In `MockData`, `ChampionshipDay`, `Game`, `StatewideGame`, plus `DataService.shared`
from `PlayoffsViewModel` and `TeamDetailViewModel`. They PREDATE the iOS 17 bump — they
are about actor isolation, not deployment target — and are warnings today, errors only
under the Swift 6 language mode.

They belong with the `@Observable` work: both are "modernise the concurrency and
observation story", both touch the same files, and doing them together means one
regression pass instead of two.

**Watch for:** the fix is not simply annotating everything `@MainActor`. `DataService`
already is, and that annotation is what fixed the P5 data race — but formatters and
time zones on model types are pure values that should be `nonisolated`/`static let`
rather than actor-bound. Getting that backwards would push work onto the main actor that
does not belong there.

---

## Pre-warm coverage for Washington — Spencer's UptimeRobot dashboard

**Due with window #3.** Per-state launch gate: the pre-warm mechanism currently covers
Oregon only, so Washington's first request of the day pays the cold-start cost that
Oregon stopped paying at v1.6.0.

Today one monitor pings `/api/rankings/laxnumbers` every 5 minutes. That is a **v1,
Oregon-only** endpoint — it warms the container and the connection pool, which helps
every state, but it exercises none of the v2 Washington paths.

### What Spencer needs to add

Same 5-minute interval, same alert settings as the existing monitor:

| # | URL | why this one |
|---|---|---|
| 1 | `https://api.varsitylaxapp.com/api/v2/rankings/laxnumbers?season=2026&state=WA` | the WA rankings snapshot query — different snapshot row, different index path from Oregon's |
| 2 | `https://api.varsitylaxapp.com/api/v2/schedule/playoffs?season=2026&state=WA` | the heaviest WA query: 43 games plus the playoff-graph walk over four brackets |

**Two, not six.** These are the two that touch WA-specific query paths; `/teams` and
`/schedule/all` warm the same connection pool the existing monitor already keeps hot, and
more monitors on a free plan buys noise rather than coverage.

### Watch for

The alert threshold on the free plan is **unverified** — recorded as a decision in
window #1 and still not checked. A deploy blip will page on these two exactly as it does
on the existing monitor, so announce a window before starting.

`/api/v2/playoff-formats?state=WA` is deliberately NOT on the list: it is cheap, cached
per (state, season) by the client, and only fetched when the Playoffs screen opens.
