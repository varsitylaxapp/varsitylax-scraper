# Roadmap — 2026 game scores for AZ, ID, MT, NV

**Status: FEASIBLE. Probe complete — the data exists, is complete, and is parseable.
Scoping below is complete. Builds after 2.0 is submitted.**

Builds after 2.0 is submitted. Nothing here touches the release.

The goal: the four rankings-only states currently show a ranked list and nothing else.
LaxNumbers already knows the 2026 game results behind those ratings — a rating is computed
from games — so the question is whether those games are retrievable in a machine-readable
form.

---

## 1. The probe — ANSWERED. The data is there and it is complete.

`/team_info.php?t=<team_nbr>` returns an HTML page whose schedule table holds every game.
`team_nbr` comes from the ratings service, which already runs in production.

### Format: HTML, not JSON

No embedded JSON payload — the games are table rows, parsed with the same approach as the
OHSLA scraper. Each row:

```
["2026-01-31", "12:30", "Palo Verde",          "n/a", "18 - 5",  ""]
["2026-02-25", "19:30", "at Corona del Sol",   "",    "19 - 2",  ""]
```

| field | source | note |
|---|---|---|
| date | col 0 | already ISO `YYYY-MM-DD` — no parsing, no ambiguity |
| time | col 1 | 24h, occasionally blank |
| opponent | col 2 | **`at ` prefix is the home/away signal** |
| score | col 4 | `"18 - 5"`, this team first |

### Completeness: total, across all four states

One team sampled per state, result rows checked against the ratings service's own `gp`:

| state | team | `gp` | result rows | with a score |
|---|---|---|---|---|
| AZ | Brophy Prep | 23 | **23** | **23** |
| ID | Timberline | 12 | **12** | **12** |
| MT | Billings Beartooth | 15 | **15** | **15** |
| NV | Palo Verde | 24 | **24** | **24** |

Every game accounted for, every one scored, no gaps. Home/away resolves for all of them.

### Request count for a full pull

One request per team plus one per state. LaxNumbers' own rosters are larger than ours —
AZ 17, ID 31, MT 6, NV 15 = **69 teams, so ~73 requests**. A single sequential pass with
ordinary politeness delays is a few minutes, once.

---

## 2. ⚠️ A correction worth keeping: how this probe first failed

The first attempt concluded the probe was **blocked**, on the evidence that every endpoint
returned 403 from this machine — including Oregon's, which production scrapes successfully
every two hours. That looked like conclusive proof of an environmental block: the control
failed too.

**It was wrong.** The 403s came from `curl` with a hand-written two-header request. The
scraper uses axios, whose fuller default header set (`Accept`, `Accept-Encoding`,
`Connection`) Cloudflare accepts. Run through the actual scraper module, this machine
reaches all five states immediately — AZ 17 teams, ID 31, MT 6, NV 15, OR 41.

The lesson is narrow and worth stating: **a control only controls for what it shares with
the thing being tested.** Oregon 403ing looked like a control for "is it the environment",
but both requests came from the same wrong client, so it controlled for nothing. The real
control was the scraper itself — the code that is known to work — and it was one command
away the whole time.

Recorded rather than quietly deleted, because the false conclusion was confidently argued
and nearly closed a viable roadmap item.

## 3. The import chain this would imply

Four problems, three of them already solved elsewhere in this codebase.

### 3.1 Alias resolution WITHOUT a curated list — the genuinely new one

Oregon and Washington both had human-curated identity: OHSLA names were reconciled by hand,
and WHSBLA shipped `alias-decisions.json` with rulings. **Neither exists for these four
states.** A LaxNumbers opponent string is whatever LaxNumbers calls that school.

The rule this codebase already committed to (`docs/data-quirks.md`, the P5 blast-radius
ruling) applies: an unresolved name must become a **placeholder team with provenance**, not
a silent drop and not a guess. `unresolved_aliases` already exists and already carries
occurrence counts — the table is built for exactly this.

Expect the tail to be long: cross-border opponents ("Bishop Gorman", out-of-state
tournament entries) will resolve to nothing in a four-state roster and must not invent
teams that then appear in `/teams`.

### 3.2 Dedup against existing cross-border rows — SOLVED, reuse it

These states already appear in Oregon's and Washington's feeds as cross-border opponents.
A LaxNumbers import must not duplicate those rows.

The orientation-independent unique key (`uq_game` over `season, team_lo, team_hi,
game_date`, section I) and the importer's orientation-independent ownership lookup are
exactly this mechanism, and window #3 just proved they work: importing 502 Washington games
added **zero** duplicate Oregon rows, because the 24 cross-border games matched rather than
duplicated. Reuse that path; do not write a new one.

### 3.3 Provenance — SOLVED, extend it

`game_source_records` and `game_source_priority` already exist. `source = 'laxnumbers'`
becomes a new row in the priority table, and it should rank **below** OHSLA and WHSBLA:
where a league's own export and a ratings site disagree about a score, the league wins.

That also settles the cross-border case cleanly — an OR-vs-AZ game keeps its OHSLA row and
its OHSLA score, and the LaxNumbers view of it is recorded but not authoritative.

### 3.4 The capability flip — one line per state

`hasSchedules: false → true` in `src/config/states.js`, per state, **only once that state's
data is actually in**. The contract (`docs/api-contract.md` §3.1) is explicit that flags
gate the UI rather than the endpoints, and window #3's whole premise was that advertising a
capability ahead of its data produces a state that looks broken rather than empty.

Flip per state as each lands. Not all four at once.

---

## 4. The product fact that makes this worth doing

**It ships SERVER-SIDE. Installed 2.0 apps light up with no update.**

The client already asks `/api/v2/states` what each state offers and renders from the
answer. A state whose `hasSchedules` flips to true starts showing Scores in an app the user
installed weeks earlier — no App Store submission, no review, no version gate, and no
action from the user.

That is the payoff of the capability-flag design, and it inverts the usual economics: the
work is entirely backend, the release risk is a config change per state, and the rollback
is the same line set back to false. It also means this can ship in four independent
increments rather than one, each one a state going from "rankings only" to a full app.

**Which is why it can safely wait until after 2.0 is submitted** — and why it should not be
rushed into it.
