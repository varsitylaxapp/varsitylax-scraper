# API contract

The semantics a client needs and cannot get from the payload alone.

**Why this exists.** An Android client is coming, and until now every non-obvious rule in
this API lived either in a comment in `src/api-v2.js` or — worse — in the Swift that
happens to consume it. A second client would have had to reverse-engineer those rules
from behaviour, and would have got several of them wrong in ways that look like working
code. Everything here is derived from the committed captures in `payload-baseline/`, so
it describes what the API actually serves rather than what anyone remembers it serving.

**Keeping it current.** Same rule as the capture list: a payload change and its contract
edit land in the same commit. A contract that drifts from the payload is worse than none,
because it is believed.

**How this was sourced.** Every payload shape, key, and nullability rule below was read
out of `payload-baseline/`. Ordering guarantees were read out of the `ORDER BY` clauses in
`src/api-v2.js`, not inferred from the captures — observed order and promised order are
different claims. Status codes were probed against staging. `/health` is the one endpoint
described from source, because it is deliberately not captured (§8).

**Scope.** `/api/v2` is the contract. `/api` (v1) is legacy, sunsetting ~Oct 2026,
documented at the end only because it is still live.

---

## 1. The traps — read this section even if you read nothing else

These are the four things a new client gets wrong. Each is invisible until it is a bug.

### 1.1 `round` counts BACKWARD from the final

On `/schedule/playoffs`, `round: 0` is **the final**, `1` is the semifinal, and larger
numbers are earlier. A client that assumes forward counting renders a bracket that looks
entirely plausible and is inverted.

Depth from the final is the only number the graph actually knows. A forward count
("this team's Nth game") requires the bracket's total depth, which is a property of the
FORMAT and not of any single game — and the brackets are lopsided (§1.2), so it cannot be
computed per game either.

To lay out columns left-to-right: `column = maxRoundPresent - round`.

### 1.2 Never compute bracket layout from `fieldSize` / `playInGames`

Real brackets are **not balanced**, and two of the six 2026 brackets are not balanced in
ways arithmetic cannot express:

| bracket | fieldSize | playInGames | max round | reality |
|---|---|---|---|---|
| `cascade_cup` | 16 | 0 | 3 | balanced |
| `wa_private` | 16 | 0 | **4** | power-of-two field, still plays 2 preliminaries and byes 2 teams to the quarterfinals |
| `wa_4a` | 17 | 1 | **5** | a balanced 17-team field maxes at depth 4 |

`playInGames` is `fieldSize - 2^floor(log2(fieldSize))`. It assumes the only irregularity
is a single play-in column. For `wa_private` that assumption yields 0 while the bracket
genuinely plays two preliminary games.

**Columns come from the maximum `round` present; each game sits at its own `round`.**
`fieldSize` is a qualification fact (17 of 4A's 27 teams qualified) suitable for prose.
Neither number is a layout input. Full analysis in `docs/data-quirks.md`.

### 1.3 `date` and `advancesTo.date` are the SAME logical day in DIFFERENT formats

Within a single playoff game object:

```json
"date": "2026-04-29T07:00:00.000Z",
"advancesTo": { "date": "2026-05-02", "slugs": ["emerald_ridge_wa", "kamiakin_wa"] }
```

`date` is a full ISO instant; `advancesTo.date` is a bare calendar day. **Comparing them
directly never matches.** To resolve an `advancesTo` reference to a game in the same
payload, take `date.slice(0, 10)` and pair it with the game's own two slugs sorted.

The `07:00:00.000Z` is not a time of day. The database stores Pacific wall-clock and the
container runs UTC, so midnight Pacific surfaces as 07:00Z (08:00Z in winter). Slicing the
first ten characters yields the correct calendar day; converting to a local timezone first
does not, and will shift the date by one for anyone east of Pacific.

This is a wart. Tracked as a candidate additive fix — add an explicit `dateKey` field
rather than change `date`, which would be breaking.

### 1.4 One key is snake_case in an otherwise camelCase payload

`/rankings/*` returns `rank_position`. Every other key in v2 is camelCase.

It has gone unnoticed because the iOS client decodes with Swift's
`convertFromSnakeCase`, which silently rewrites it to `rankPosition` — an **iOS-flavoured
tolerance**, exactly the class of thing this document exists to eliminate. A client using
explicit field mapping needs an annotation on this one field and no others.

Tracked as a candidate additive fix: emit `rankPosition` alongside, retire
`rank_position` once iOS stops reading it.

---

## 2. Absent keys

**Absence is never "unknown".** Every optional key in v2 has a defined meaning when
missing, and in one case absence means the *default value*, not the lack of one.

### 2.1 `division` — omitted means DEFAULT, affirmatively

On `/teams` and `/rankings/*`, `division` is **omitted entirely** when the team's division
is its state's default, and present only for genuinely multi-division states.

```jsonc
// WA — multi-division, division present
{ "slug": "anacortes_wa", "name": "Anacortes", ..., "division": "2A" }
// OR — or_open is the default division, key absent
{ "slug": "aloha_southridge", "name": "Aloha/Southridge", ... }
```

A client that reads absence as "division unknown" gets Oregon wrong: every Oregon team is
in `or_open`, affirmatively. The correct reading is "this state does not divide, so there
is nothing to show" — render no chip, not an "Unknown" bucket.

Cross-check against `/states`: a state whose `divisions` is a single entry with
`isDefault: true` will never send `division`.

### 2.2 `leagueName` — null means MULTIPLE, not missing

`null` for Idaho and Nevada because those states span several leagues, and naming one
over the whole list would be wrong. Non-null means one league governs every listed team.

Use it for a context line; fall back to `displayName` when null. Never assume a state has
a single league.

### 2.3 Nullable value fields

| field | null means |
|---|---|
| `venue` | no venue recorded. Common — all four WA finals have `venue: null`. |
| `mascot`, `city`, `conference` | not curated for this team. WA is largely uncurated. |
| `home.score` / `away.score` | no result yet, or a result that will never come (§4.2) |
| `bracketKey` / `round` / `advancesTo` | the server assigned no bracket position (§3.3) |
| `advancesTo` alone | this game is a final — `bracketKey` and `round` are still set |
| `playoffsStart` | null when `playoffSource` is `game_type`; only meaningful for `date_window` |
| `laxnumbers` / `laxpower` on `/rankings/both` | no snapshot for that source (§3.2) |

---

## 3. Capabilities, and the designed "capability true, data absent" state

`/states` reports three flags per state:

```json
"capabilities": { "hasRankings": true, "hasSchedules": false, "hasPlayoffs": false }
```

### 3.1 Flags gate the UI, not the endpoints

Every endpoint answers for every valid state. Arizona has `hasPlayoffs: false`, and
`/schedule/playoffs?state=AZ` still returns **200** with `games: []`. The flag tells a
client which tabs are worth showing; it does not predict a status code.

**Gate on the capability itself, never on a correlated property.** A gate built on
`divisions.length === 1` once let Arizona render Oregon's bracket UI, because
single-division correlated with has-playoffs across the only two states it was tested
against, and diverged on the third.

### 3.2 Capability true, data absent is a DESIGNED state, not an error

Arizona has `hasRankings: true` and yet:

```
GET /api/v2/rankings/laxnumbers?season=2026&state=AZ   → 404
{ "error": "no laxnumbers snapshot for season 2026" }
```

The product offers rankings for Arizona; this season's snapshot does not exist yet. That
is "coming soon", not a failure, and a client must distinguish it from a network error —
showing a retry button for a season that has not started is noise the user can do nothing
about.

**Map 404 on a capability-true endpoint to a "coming soon" empty state, not to an error.**

Washington shows the same shape one level down: `/rankings/both?state=WA` returns
`laxnumbers` populated and `laxpower: null`, because only one source covers WA.

### 3.3 An unassigned playoff game is legitimate

`bracketKey: null` on `/schedule/playoffs` is not a server bug. Two ordinary causes: a
division with no declared bracket, and a cross-border game that appears in this state's
feed because one side is in-state but belongs to neither state's tournament. Render such
games in a flat list or omit them; do not treat them as an error.

### 3.4 `declared` vs `resolved` on `/playoff-formats`

```json
{ "declared": 4, "resolved": 4, "brackets": [ ... ] }
```

`brackets` contains only formats whose final resolved to a real game. `declared > resolved`
means a final was rescheduled and the anchor no longer matches. **Surface the gap; do not
invent the missing bracket.** Both numbers are reported precisely so a client can say
"one bracket is unavailable" instead of silently showing three where there are four.

---

## 4. Vocabularies

### 4.1 `gameType`

`league` · `non_league` · `playoff` · `exhibition` · `practice`

Observed in 2026: OR uses `league`, `non_league`, `exhibition`, `playoff`; WA uses
`league`, `non_league`, `practice`, `playoff`.

- **`playoff` is the playoff signal.** `/schedule/playoffs` prefers it and reports
  `playoffSource: "game_type"`. The date-window fallback exists only for a (season, state)
  whose rows were never typed, and it was wrong in both directions: Oregon had no typed
  rows at all, while 19 of Washington's 43 typed playoff games fall *before* the window
  and were silently dropped.
- **`exhibition` and `practice` are excluded from win-loss records.** A client computing a
  record from a schedule must exclude both, or it will disagree with the server's own
  `record` field.

### 4.2 `status`

`scheduled` · `completed` · `cancelled` · `postponed` · `stale`

**`stale` is never served.** All four game endpoints filter `status <> 'stale'`; 9 rows
currently carry it on staging, and a client will never see one. It exists
because the upstream sources are *additive-only* — OHSLA never retires a fixture, so a
cancelled game stands in the feed forever and a prune can never fire. Staleness is decided
by elapsed time instead: no score, still `scheduled`, more than 14 days past its date.
See `src/stale-fixtures.js`.

The consequence for a client: a `scheduled` game whose date has passed is in the window
before that rule fires. **Render it as an absence of a result — a quiet dash — never as
"upcoming".** It is not a fixture the user should be told to wait for.

---

## 5. Ordering — what is contractual

Clients depend on order, so this says which orders are promised and which are incidental.
Derived from the `ORDER BY` in `src/api-v2.js`, not from observation.

| endpoint | order | contractual? |
|---|---|---|
| `/rankings/*` | `rank_position` ascending | **YES.** The order *is* the ranking. |
| `/playoff-formats` | `sort_order`, then `bracket_key` | **YES.** Clients render bracket selectors in this order; it is the league's own ordering (4A, 3A, 2A, PV/Open). |
| `/schedule/all`, `/schedule/playoffs`, `/schedule/team/:slug` | `game_date`, then `id` | **YES for date.** Chronological is promised. The `id` tiebreak is stability-only — do not attach meaning to the order of same-day games. |
| `/teams` | team name ascending | **Currently true, NOT promised.** It is alphabetical by `name` today. A client that needs alphabetical should sort; a client that needs another order must sort regardless. |
| `/states` | config declaration order | **Currently true, NOT promised.** Sort by `displayName` if display order matters. |
| `brackets[]` within `/playoff-formats` | as above | YES |
| `divisions[]` within `/states` | config declaration order | **Currently true, NOT promised.** |

Where a row above says NOT promised, it means a future change may reorder without being
treated as a breaking change — so it will pass the additive-policy check in §7.

---

## 6. Identity and references

### 6.1 ids are display labels' machine keys — never show an id

`divisions[].id` is a string key (`or_open`, `wa_4a`, `wa_private`); `divisions[].label`
is what a human reads (`Open`, `4A`, `PV/Open`). Likewise `playoff_formats.key` vs
`displayName`.

`wa_private` / `"PV/Open"` is the canonical example, and getting it backwards is a real
mistake that has been made on this project. **Match on the id; render the label.**

Note that `division` on a `/teams` row carries the **label** (`"2A"`), not the id — it is
a display field. Division *ids* appear only in `/states` and as `divisionId` on
`/playoff-formats`.

### 6.2 References between games are NATURAL, never ids

`advancesTo` identifies a game by `{date, slugs}` — the calendar day plus the two team
slugs, **sorted** — and never by `game.id`.

```json
"advancesTo": { "date": "2026-05-02", "slugs": ["emerald_ridge_wa", "kamiakin_wa"] }
```

Game ids are environment-local and re-import-mutable. Staging's ids already differ from
production's; a dedupe once deleted six rows; a schema migration renumbered every game.
A reference stored or transmitted as an id breaks the day the data is rebuilt.

The slugs are sorted on the wire, so orientation (which team is nominally home) can never
affect whether two references match. A client comparing references must sort too.

`finalGameId` on `/playoff-formats` is the one id that crosses the wire, and it is
resolved server-side from a natural key for the client's convenience within a single
response. Do not persist it.

Team slugs ARE stable and are the correct cross-request identity for a team.

---

## 7. Evolution policy — additive only

**New keys may be appended. Nothing is removed, renamed, reordered, or changed in
meaning.** A client that ignores unknown keys will never break.

Enforced, not merely intended:

- `scripts/capture-payloads.sh` defines the covered surface. An endpoint absent from it
  is an endpoint whose regressions are invisible. New routes are added there **in the
  same commit** as the route.
- `scripts/payload-diff.js` compares two captures and reports added / removed / changed /
  reordered keys separately. A release is additive when the count is additions-only.
- `payload-baseline/` is a committed capture, so the check survives across sessions. Its
  README is explicit about which verdicts age well (`ADDED`/`REMOVED`/`REORDERED`) and
  which drift with the data (`CHANGED`).

The authoritative proof for any change is two captures taken minutes apart against the
same database — before and after — which holds the data still so `CHANGED` must be zero.

Fields added under this policy so far: `gameType`, `isForfeit`, `division`, `bracketKey`,
`round`, `advancesTo`.

---

## 8. Dates and times

| field | format | notes |
|---|---|---|
| `date` (all game endpoints) | ISO instant, e.g. `2026-04-29T07:00:00.000Z` | Represents a Pacific calendar DAY, not an instant. Take the first 10 characters. See §1.3. |
| `datetime` | ISO instant or null | The actual kickoff. Null when no time is published. |
| `advancesTo.date` | `YYYY-MM-DD` | Bare calendar day. |
| `finalDate` (`/playoff-formats`) | `YYYY-MM-DD` | Bare calendar day. |
| `updated` (`/rankings/*`) | ISO instant with `Z` | Snapshot capture time. |
| `lastGameWrite`, `lastSnapshot` (`/health`) | ISO with **real offset**, e.g. `2026-07-28T22:09:59-07:00` | The only endpoint emitting true offsets. |

**Why `/health` differs.** Elsewhere the database's Pacific wall-clock times are parsed
into a Date's UTC fields and re-emitted with a `Z` that is technically a lie about the
zone while carrying the correct wall time. `/health` runs those through `pacificISO()`,
which keeps the wall time and appends the genuine offset (`-07:00` PDT / `-08:00` PST).

`/health` is deliberately **absent from `payload-baseline/`** — it carries live timestamps
and would differ on every capture, training a reader to ignore diffs. It is therefore the
one endpoint in this document described from source rather than from a capture.

---

## 9. Errors

| condition | status | body |
|---|---|---|
| unknown `state` code | 400 | `{ "error": "unknown state 'ZZ'" }` |
| no snapshot for (source, season, state) | 404 | `{ "error": "no laxnumbers snapshot for season 2026" }` |
| unknown team slug | 404 | `{ "error": "unknown team slug 'xyz'" }` |
| server fault | 500 | `{ "error": "<message>" }` |

Every error body is `{error: string}`. **404 on a capability-true endpoint is a
"coming soon" state, not a failure** (§3.2) — the single most important distinction in
this table.

The `state` parameter defaults to `OR` when omitted, on every endpoint that accepts it.
That default exists so the originally-shipped iOS client keeps working unchanged; a new
client should always send `state` explicitly.

---

## 10. v1 (`/api`) — legacy

Sunsetting ~Oct 2026. **A new client must not use it.** Documented only because it is
still live and still the fallback for one iOS path.

**It is not a view over v2's data.** This is the fact that matters most and the one
easiest to assume away. v1 reads `team_schedules` — the ORIGINAL scraper's table — while
v2 reads `games`. They are separate tables populated by separate paths, so:

- **The id spaces are disjoint and unrelated.** A v1 playoff game carries `id: 149082`; the
  same fixture in v2 is `id: 27`. There is no mapping. Never correlate a v1 id with a v2
  id, and never store either (§6.2).
- **The row sets differ.** `/api/schedule/playoffs` selects `game_date >= '2026-05-14'`
  from `team_schedules` with no game-type filter and a hardcoded 2026 date, so it returns
  games v2 correctly excludes — including non-playoff games played inside the window, and
  fixtures v2 has since reconciled. The counts do not reconcile and are not meant to.

Other differences:

- **Keys are snake_case and differently named**: `home_team_id`, `away_team`, `game_date`,
  `game_time`, `scraped_at`. Rankings use `teamName` with no `slug` at all.
- **No team slugs in rankings or playoff games** — only names. This is why v1 cannot serve
  as a fallback for anything that must match a team across endpoints, and why the iOS
  client's v1 fallback survives on `/schedule/team/:slug` alone.
- **No `state` parameter.** v1 is Oregon-only by construction.
- **No `gameType`, `isForfeit`, `division`, or any graph field.**
