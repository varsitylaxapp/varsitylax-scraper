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
