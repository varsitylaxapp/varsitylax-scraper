# Roadmap — 2026 game scores for AZ, ID, MT, NV

**Status: feasibility probe ATTEMPTED and BLOCKED from this environment. Scoping below is
complete; the format question is not answered.**

Builds after 2.0 is submitted. Nothing here touches the release.

The goal: the four rankings-only states currently show a ranked list and nothing else.
LaxNumbers already knows the 2026 game results behind those ratings — a rating is computed
from games — so the question is whether those games are retrievable in a machine-readable
form.

---

## 1. The probe, and why it returned nothing

Every LaxNumbers endpoint returns **HTTP 403** with a Cloudflare interstitial from this
machine:

```
ratings/service?y=2026&v=3013   403
ratings.php?y=2026&v=3013       403
current-rankings/boys           403
team_info.php?t=1               403
```

**The control is what makes this readable.** `v=3443` is OREGON — the endpoint production
scrapes every two hours — and it returns 403 here too. Meanwhile production's own scrape
succeeded three times today:

```
2026-07-30T22:02:35  laxnumbers-v2/OR  success  41
2026-07-30T20:00:39  laxnumbers-v2/OR  success  41
2026-07-30T18:04:42  laxnumbers-v2/OR  success  41
```

So this is **environmental, not data-specific**: the deployed container's requests are
served and this machine's are challenged. Nothing is wrong with LaxNumbers, nothing is
wrong with production, and no conclusion about the four states can be drawn from a 403
that Oregon also receives.

**No attempt was made to work around the challenge.** Defeating bot detection to take data
a site is actively gating is not something to do quietly in a feasibility probe, and it
would change the project's relationship with a source it currently uses politely and
within an agreed shape.

### How to actually answer question 1

Run the probe from where the requests already succeed:

- a one-off script on the Railway container (same egress as the cron), OR
- a temporary `--probe` mode in `src/scrapers/laxnumbers.js` that fetches one team's page
  per state, logs the shape, and writes nothing.

The second is cheap and reuses the exact headers that work today (`User-Agent` plus a
`Referer` matching the ratings page). **Until that runs, questions 1 and 2 below are
open**: format, fields, completeness, and per-team request cost are unknown, and the
honest answer is that they were not measured rather than estimated.

---

## 2. What can be said without the probe

**Request volume.** The four states hold roughly 62 teams (AZ 6, ID 24, MT ~16, NV ~16 by
the current rosters). If per-team game data needs one request each, a full pull is ~62
requests plus 4 ratings calls — a once-a-day job at worst, trivially inside any polite
rate. If a single per-state call carries every team's schedule, it is 4 requests. The
difference matters for scheduling, not for feasibility.

**Season boundary.** This is the JUST-COMPLETED 2026 season, not a historical archive.
`SEASON` is already threaded through the scraper (`y=${SEASON}`), and the 2027 season has
not started, so a backfill is a fixed target rather than a moving one.

---

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
