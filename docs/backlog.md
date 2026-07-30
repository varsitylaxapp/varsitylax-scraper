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
