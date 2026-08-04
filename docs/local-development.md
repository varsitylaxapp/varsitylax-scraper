# Running the API locally against staging

iOS development needs Washington data before stage (c) ships it to production.
Staging already holds it; the API can be pointed there and run on your machine,
and the iOS Debug scheme points at that.

## Start the API against staging

`.env` must contain `STAGING_DATABASE_URL` (Railway → MySQL service → Variables →
`MYSQL_PUBLIC_URL`).

```bash
cd varsitylax-scraper
node src/api.js --target=staging
```

It prints its resolved target on boot. **Read this line every time** — it is the
only thing standing between a local experiment and production:

```
[db] target=STAGING host=sakura.proxy.rlwy.net db=railway user=root
VarsityLax API running on port 3000
```

If it says `target=PROD`, stop. Without `--target=staging` the process resolves
to the production database, and `src/db.js` will refuse to start if
`STAGING_DATABASE_URL` is missing rather than silently falling back.

Override the port with `PORT=3999 node src/api.js --target=staging`.

### A local API starts with a task and dies with it. Never leave one running.

Stop it when the thing you started it for is finished, and check the port is clear:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN     # expect no output
```

**This is not tidiness — a long-lived stray on :3000 is a proven gate-inverter.** On
2026-08-04 a `node src/api.js` left running since 07:49, pointed at staging, held the port
while `rehearse-on-prod-schema.sh` booted its own API against a production dump. The new
process lost the port and every request in the smoke went to the stray one. **Four
consecutive runs certified "HEAD boots and serves against prod's schema" while measuring
staging** — in the gate built specifically to stop greens that had run against staging.

A stray is dangerous precisely because it answers. Nothing times out, nothing errors, and
the numbers look plausible; they are simply about a different database. It cost a set of
published pins and an invented "lost write" anomaly that was chased for hours.

The rehearsal now defends itself — dedicated port, refused if occupied; the API's own
`[db]` line must read `REHEARSAL` and its **absence is fatal**; and API and container are
asked the same question and must agree. Those defences exist because this rule was broken,
not as a substitute for it.

```bash
curl -s localhost:3000/api/v2/states | jq
curl -s 'localhost:3000/api/v2/rankings/laxnumbers?state=OR' | jq '.rankings | length'
curl -s 'localhost:3000/api/v2/schedule/playoffs?state=WA' | jq '.games | length'
```

## Two iOS-side changes this workflow still needs

Neither exists yet. Both are app changes, not backend.

**1. `Config.swift` has no Debug branch.** `apiHost` is a hardcoded constant, so
a Debug build cannot be pointed at localhost:

```swift
static let apiHost = "https://api.varsitylaxapp.com"
```

It needs something like `#if DEBUG` → `http://localhost:3000`, ideally read from
a scheme environment variable so the port is not baked in.

**2. App Transport Security will block it.** `Sources/App/Info.plist` contains no
`NSAppTransportSecurity` key, so iOS blocks cleartext HTTP by default and every
request to a local API fails before it reaches the network. A Debug-only
exception is required — `NSAllowsLocalNetworking`, or an `NSExceptionDomains`
entry for `localhost`. **Never ship it in Release.**

Simulator reaches the host at `localhost`. A physical device needs your Mac's LAN
address (`ipconfig getifaddr en0`) and the same ATS exception.

## What staging actually contains

Point at staging expecting this, not the full six-state picture:

| State | Teams | Games | Rankings | Notes |
|---|---|---|---|---|
| OR | 41 | 354 | ✅ laxnumbers + laxpower | complete |
| WA | 77 | 508 | ✅ laxnumbers (75) | roster, schedule, playoffs, 2026+2027 classifications |
| AZ | 6 | — | ❌ none | opponent placeholders, not a roster |
| ID | 5 | — | ❌ none | opponent placeholders |
| MT | 2 | — | ❌ none | opponent placeholders |
| NV | 6 | — | ❌ none | opponent placeholders |

### ⚠️ `/api/v2/states` advertises more than staging can serve

The endpoint reports what the **product** offers per state. It is served from
`src/config/states.js` and reads no tables, deliberately — capability must not
flicker with whatever rows happen to exist.

The consequence during development:

```
OR  rankings 200      WA  rankings 200      AZ ID MT NV  rankings 404
```

Washington was closed on 2026-07-29 by a one-off scrape into staging
(`scripts/scrape-state-rankings.js WA --target=staging --commit`) — 75 rows, all
resolving, no team rows created. The four rankings-only states remain in the gap
by design; their data arrives at each state's enablement gate.

**Build the app to treat "capability true, data absent" as a real state**, not as
an error. It will occur in production too, in the window between a state
appearing in the picker and its first scrape landing.

### Non-curated state hygiene is a gate, not a chore

Before any rankings-only state's scrape is enabled — staging or prod — reconcile
its placeholder rows against the LaxNumbers team list and merge duplicates
through `alias-decisions.json` with provenance. Non-curated states have no roster
lock, so nothing prevents a duplicate arriving from a second source.

### The keeper rule

**In a merge, the keeper is the row that CARRIES MORE** — seasons, games, ranking
entries, provenance. Never the row that happened to be created first, and never
decided by which source created it.

Two worked examples, deliberately pointing in **opposite directions**:

| Merge | Kept | Why |
|---|---|---|
| `brophy_prep_az` → **`brophy_az`** | the **a7** row | held the only game FK and the fuller canonical name |
| `bishop_blanchet_wa` → **`blanchet_wa`** | the **export** row | 6 games vs 1, two seasons vs none, a ranking row vs none |

If the rule were "prefer the league export" or "prefer the older row", one of
these two would be wrong. Weight decides.

### The sweep

`scripts/reconcile-placeholders.js <STATE> --target=staging` is READ-ONLY and
reports candidates only. **Run it at the enablement gate for every curated-state
onboarding** — a7-era placeholders predate the roster lock everywhere a7 touched.

**Design property, deliberately tuned: it OVER-REPORTS.** Matching strips generic
words (prep/academy/catholic/college), which collides genuinely distinct schools.
That is the correct trade: a false positive costs a human one minute of review; a
false negative is an irreversible-feeling data bug that surfaces months later.
Do not "improve" precision at the cost of recall.

Pairs a human rules DISTINCT go in `alias-decisions.json` under `do_not_merge`,
and the sweep **reads and suppresses them** — a rejected candidate is never
re-proposed by a later sweep, tool, or session. Negative knowledge is knowledge.

### WA result, 2026-07-29

Of 16 a7-era WA placeholders, **15 were cleanly adopted** by the WHSBLA import and
exactly **one** was a duplicate. The alias-resolution layer did its job almost
perfectly at import time; the sweep exists for the exception.

```
LIKELY    bishop_blanchet_wa -> blanchet_wa    MERGED
LIKELY    seattle_prep_wa    vs seattle_academy_wa   DISTINCT (also vs west_seattle_wa)
POSSIBLE  mount_si_wa        vs mount_vernon_wa      DISTINCT
POSSIBLE  north_creek_wa     vs north_kitsap_wa      DISTINCT
```

Re-running the sweep after recording those rulings yields **0 candidates**.

### The AZ / ID / MT / NV rows are not rosters

Those five-to-seven teams are **opponent placeholders** — Oregon and Washington
schools' out-of-state opponents, seeded from `a7-classification.json` and the
WHSBLA export. Arizona has 17 real programs per LaxNumbers; staging holds seven
Arizona *opponents*.

Do not treat them as a roster, and do not compute a context-line count from them
— the count binds to rendered rankings rows, which for these states is currently
nothing.

The `brophy_az` / `brophy_prep_az` duplicate found here has been merged — see
above. The remaining AZ/ID/MT/NV placeholders stay as they are until each state's
enablement gate.

## Safety rails already in place

- `src/db.js` refuses `--target=staging` unless `STAGING_DATABASE_URL` is set,
  and refuses if that URL's host equals `DB_HOST`
- Missing `DB_*` variables are a startup failure — no silent localhost fallback
- Every process announces its resolved target before it writes anything
- One-off scripts (`staging-verify-scrape.js`, `import-whsbla.js`) additionally
  refuse to run unless the resolved target is staging

Any probe against production goes in a transaction with an explicit `ROLLBACK` —
including probes expected to fail. A should-fail probe is exactly where the
environment surprises you.

## Trusting an iOS build result

`xcodebuild` reports errors from the first file that fails to type-check and
then stops. It does **not** enumerate every broken file in the module.

This misleads in a specific, expensive way: a build reporting 40 errors "all in
MockData.swift" looked like MockData was the only problem, while `DataService`
sat mid-edit with `throw` statements in non-throwing functions and stale
initializer calls that had simply not been reached yet. Fixing the reported file
and rebuilding surfaced an entirely new front each time.

So the only trustworthy clean signal is **a full build run after the last edit**
— not an earlier build, and not an error list from a build whose first file
failed. Corollary: a shrinking error count across rebuilds is not progress
toward zero, it is the compiler getting further into the module.

SourceKit diagnostics in an editor are weaker still. Without a full index they
routinely report `Cannot find 'Config' in scope` for a type in the same module.
Treat them as hints; `xcodebuild` is the arbiter.
