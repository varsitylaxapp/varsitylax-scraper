# Session Summary — April 19, 2026

## Session scope

Full-day design and implementation session covering:
1. Backend migration runbook (Sections A–E) — complete Phase 3 implementation guide
2. Oregon-only scope decision for season 1
3. Season 1 light live scoring feature design

---

## Outcomes

### Migration runbook (Sections A–E)

All five runbook sections written, reviewed, corrected, and locked to `db/` as chmod 444 files. Committed `4b5ac75`.

| File | Steps | Size |
|------|-------|------|
| `db/runbook-section-a.md` | A1–A13 (pre-flight audit, read-only) | 24,292 bytes |
| `db/runbook-section-b.md` | B1–B5 (schema creation + sign-off) | 25,198 bytes |
| `db/runbook-section-c.md` | C1–C9 + C8.5 (data backfill) | 45,146 bytes |
| `db/runbook-section-d.md` | D1–D8 (derived data + W-L compute) | 21,200 bytes |
| `db/runbook-section-e.md` | E1–E7 + E5.5 (cutover + deprecation) | 18,364 bytes |

### Live scoring design sketch

`docs/features/live-scoring.md` written and committed `43b2598`. Season 1 trusted-reporter model: ~5 manually seeded reporters, `identifierForVendor` device auth, 500m geofence, last-write-wins conflict resolution.

---

## Key design decisions

### Schema

- Neutral matchup storage: one row per game (not per-team-perspective)
- `RANK` reserved word → `rank_position`
- `ROW_FORMAT=DYNAMIC` on all tables for large prefix support
- Generated stored column: `alias_normalized CHAR(100) AS (LOWER(TRIM(alias))) STORED` + unique index
- `canonical_source = NULL` for backfilled games (FK to game_source_priority prevents string 'backfill')
- `game_source_records.source = 'backfill'` (no FK on that column — valid)
- `status` ENUM: `('scheduled','completed','cancelled','postponed')` — NOT 'final'
- Completed-game detection: `team_score IS NOT NULL AND opp_score IS NOT NULL` (AND, not OR)
- Separate `live_scores` table rather than adding columns to `games`

### Migration sequencing

- Atomic `RENAME TABLE old → old_v1` (not DROP/CREATE) so rollback is always available
- `INSERT IGNORE` on UNIQUE KEY for idempotent seeding throughout
- `game_source_priority` seeded immediately in B3 (ohsla=100, laxnumbers=50, laxpower=0)
- D6 uses `LEFT JOIN + COALESCE(v.wins, 0)` so `wl_computed_at` is set for all rows, including teams with no completed games
- Dual-write window: 3 scraper runs AND ≥ 48 hours elapsed before E4

### API versioning + rollback

- v1 gets `Warning: 299` immediately at E4; Sunset header deferred to E5.5
- E5.5: Sunset = E5 completion date + 90 days (per Phase 2 Part 4.3)
- Option A (redirect) removed — breaks clients that don't follow redirects
- Option B (App Store expedited review) explicitly rejected
- Option C: iOS ships v2→v1 network-layer fallback before E5 executes (hard prerequisite)

### Live scoring (season 1)

- Reporter identity: `identifierForVendor` stored server-side, no user accounts
- Geofence radius: 500m default, tighten per-venue if ambiguity found in practice
- Conflict resolution: last write wins — no arbitration
- Error correction: reporter resubmits corrected score — no undo flow
- Social accountability ("Reported by Spencer W.") is a feature, not a limitation
- Finalization: `game_state='final'` copies scores to `games`, sets `status='completed'`, deletes `live_scores` row

---

## Bugs caught and fixed during review

| Section | Bug | Fix |
|---------|-----|-----|
| B | `rankings_snapshots` CREATE TABLE header dropped on regeneration | Added manually; do not regenerate Section B |
| C | After context compaction, regenerated with completely wrong team list (invented teams, wrong schema) | STOP issued; recovered correct Section C from transcript |
| D | `status = 'final'` — not a valid Phase 1 ENUM value | Changed to `'completed'` |
| D | Completed-game detection used OR instead of AND | AND: both scores must be non-NULL |
| D | D5 used wrong column names (`raw_home_team`, `created_at`) | Fixed to `home_team_raw`, `away_team_raw`; removed `created_at` |
| D | D6 INNER JOIN left `wl_computed_at` NULL for winless teams | Changed to LEFT JOIN + COALESCE |
| E | E4 hardcoded `Sunset: 2026-08-01` — wrong reference point | Split: E4 gets Warning:299 only; new E5.5 sets Sunset = E5 + 90 days |
| E | E5 had no Option C fallback prerequisite | Added hard STOP block requiring iOS v2→v1 fallback to ship first |
| E | E2 only verified rankings dual-write, not schedule | Added schedule dual-write verification queries |
| E | E3 "3 scraper runs" = 3 hours — insufficient soak time | Fixed to 3 runs AND ≥ 48 hours elapsed |

---

## Open items

### Before any runbook step executes
- [ ] Sandbox dry-run of Sections A–D against local MySQL
- [ ] iOS v2→v1 network-layer fallback (Phase 2 Part 5.4 Option C) — hard prerequisite for E5

### Before live scoring can ship (weeks 7–11)
- [ ] Backend migration Sections A–E complete
- [ ] OHSLA scraping integrated (baseline W-L correct before live scoring)
- [ ] Push notification infrastructure (shared with favorite-team-game-alert)
- [ ] `reporters` table manually seeded with initial trusted reporters
- [ ] Field-test 500m geofence at actual Oregon lacrosse venues

### Deferred to season 2
- Public signup to be a reporter
- Two-person score verification
- Reputation tracking
- Multi-state expansion

### Section F
To be generated ~60 days before actual Sunset date. Covers legacy table cleanup (`DROP TABLE games_v1`, `DROP TABLE teams_v1`, etc.).

---

## Full transcript

The complete conversation transcript (7.0 MB, 1,670 lines) is archived at:

```
docs/sessions/2026-04-19-migration-runbook-and-live-scoring.jsonl
```
