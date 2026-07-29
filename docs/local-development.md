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
| WA | 77 | 508 | ❌ **none** | roster, schedule, playoffs, 2026+2027 classifications |
| AZ | 7 | — | ❌ none | opponent placeholders, not a roster |
| ID | 5 | — | ❌ none | opponent placeholders |
| MT | 2 | — | ❌ none | opponent placeholders |
| NV | 6 | — | ❌ none | opponent placeholders |

### ⚠️ `/api/v2/states` advertises more than staging can serve

The endpoint reports what the **product** offers per state. It is served from
`src/config/states.js` and reads no tables, deliberately — capability must not
flicker with whatever rows happen to exist.

The consequence during development: five of six states return **HTTP 404** from
`/rankings/laxnumbers` while advertising `hasRankings: true`.

```
OR  rankings 200      WA  rankings 404      AZ ID MT NV  rankings 404
```

Washington is the one that will bite, because its Rankings tab is a primary
screen and it otherwise has full data. Nothing has ever run a Washington rankings
scrape — the WHSBLA import seeded teams, games and classifications, and rankings
were never part of it.

**Build the app to treat "capability true, data absent" as a real state**, not as
an error. It will occur in production too, in the window between a state
appearing in the picker and its first scrape landing.

### The AZ / ID / MT / NV rows are not rosters

Those five-to-seven teams are **opponent placeholders** — Oregon and Washington
schools' out-of-state opponents, seeded from `a7-classification.json` and the
WHSBLA export. Arizona has 17 real programs per LaxNumbers; staging holds seven
Arizona *opponents*.

Do not treat them as a roster, and do not compute a context-line count from them
— the count binds to rendered rankings rows, which for these states is currently
nothing.

Spotted while checking: `brophy_az` **and** `brophy_prep_az` both exist, almost
certainly the same school reached under two names by two different sources. It is
the class of duplicate the roster lock now prevents for curated states, but these
were seeded before that existed. Untangling waits for a real Arizona roster.

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
