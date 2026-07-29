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

Worked example, applied 2026-07-29: `brophy_prep_az` merged into `brophy_az`.
Same school (Brophy College Preparatory, Phoenix) reached from two directions —
a7-classification recorded it as an *Oregon* opponent, the WHSBLA export as a
*Washington* one. `scripts/apply-team-merges.js` repoints every reference and
refuses to delete a row anything still points at.

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
