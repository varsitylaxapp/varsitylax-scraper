# Live Scoring (Season 1 Light Version)

## The feature in one sentence
If you're within 500 meters of a known Oregon lacrosse venue during a scheduled game window, the app offers to let you report the live score. Your updates appear immediately on the Scores tab labeled with your name.

## Why this shape
- Full crowdsourced version (two-person verification, anonymous contributors, abuse mitigation) was considered and deferred to season 2
- Season 1 targets 5-ish trusted reporters, manually added to the database by the app owner
- Trade-off: smaller coverage, but solves the cold-start problem by design and creates a real moat with minimal engineering
- Social accountability ("Reported by Spencer W.") is a feature, not a limitation — fits Oregon lacrosse's tight community

## Scope for season 1
IN scope:
- Geofenced score entry for trusted reporters
- Live display on Scores tab with "LIVE" badge and reporter name
- Auto-merge to games table when reporter marks game final
- Push notifications when a favorited team's score updates

OUT of scope:
- Public signup to be a reporter (manual DB insert only)
- Two-person verification
- Anonymous contributions
- Conflict resolution between reporters (last write wins)
- Clock time granularity (game state = quarter is enough)
- Play-by-play
- Multi-state or non-lacrosse sports

## Data model
Two new tables, both additive to the post-migration schema:

`reporters` table: `id`, `display_name`, `device_id` (from iOS `identifierForVendor`), `is_active`, `created_at`. Manually seeded.

`live_scores` table: `game_id` (FK + UNIQUE), `home_score`, `away_score`, `game_state` (ENUM: `pregame`/`q1`/`q2`/`halftime`/`q3`/`q4`/`overtime`/`final`), `reporter_id` (FK), `last_updated_at`.

On finalization: when a reporter sets `game_state='final'`, the submission handler copies `home_score`/`away_score` into `games`, sets `games.status='completed'`, and deletes the `live_scores` row.

## Backend API
`POST /api/v2/live-scores` — authenticates via `device_id` header, upserts into `live_scores`, handles finalization merge. Rate limit 1 update per reporter per game per 30 seconds.

Modify `GET /api/v2/schedule/all` and `GET /api/v2/schedule/team/:slug` to LEFT JOIN `live_scores` and include a `live` object on each game (null if no live report).

## iOS UX
- Location permission prompted once with clear copy: "VarsityLax uses your location only to confirm you're at a game before letting you report scores."
- On app foreground: get location, find venue within 500m, find matching game (today, start time −30min to +3hr). If match and user is a reporter, show score-entry card at top of Home tab.
- Score entry: big tap targets, +/- buttons not keyboard, segmented picker for game state, single Submit button.
- Scores tab: green "LIVE" badge, bold current score, "Reported by Spencer W. • updated 2m ago" subtitle.

## Design decisions already made (don't re-litigate)
- **Reporter identity:** iOS `identifierForVendor` stored server-side, no user accounts.
- **Geofence radius:** 500m default, tighten per-venue if ambiguity found in practice.
- **Conflict resolution:** last write wins. Don't build arbitration.
- **Error correction:** reporter just submits corrected score. No undo flow.
- **Separate `live_scores` table vs. adding columns to `games`:** use separate table. Keeps the freshly-migrated games table clean and makes experimentation safer.

## Open questions to resolve before building
- Does geofencing reliably disambiguate venues that share campuses or parking lots? (Unknown until tested in the field.)
- Is quarter-level granularity enough, or will reporters want to enter clock time? (Suspect quarter is enough for season 1.)
- Push notification cadence: every score update, or only on quarter transitions and final? (Probably quarter transitions + final, to avoid notification spam.)

## Estimated effort
- Schema + API: 2-3 days
- iOS location + score entry UI: 1-2 weeks
- Scores tab live display + push notifications: 1 week
- Field testing and polish: 1-2 weeks
- Total: 3-5 weeks solo, roughly weeks 7-11 of the season

## Prerequisites
- Backend migration Sections A-E complete (`live_scores` FK depends on post-migration `games` table)
- OHSLA scraping shipped (so baseline W-L is correct before live scoring further refines it)
- Push notification infrastructure in place (shared with favorite-team-game-alert feature)

## Season 2 evolution
When we revisit this for the full crowdsourced version:
- Add public signup-to-be-a-reporter flow
- Add two-person verification (verified vs unverified state on LIVE badge)
- Add reputation tracking (reporters who consistently submit accurate scores get higher weight; bad actors get flagged)
- Consider opening to other Oregon sports (baseball? soccer?)
- Only then consider multi-state expansion
