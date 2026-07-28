# WHSBLA league exports — 2026 season

## Origin and permission

Supplied by **Brandon Fortier**, WHSBLA Executive Board, who administers the
league's Sportability instance. Received **2026-07-27 / 2026-07-28**.

Washington ingestion is **export-based, not scraped**. Brandon gave verbal
approval for VarsityLax to use league data; the email thread and these exports
are the written trail. Because the data arrives as a league-blessed export,
Sportability's `robots.txt` restriction is **moot for Washington** — see
`VarsityLax_MultiState_Architecture_Plan.md` §7 / D9, where scraping was the
fallback we did not have to take.

These files are committed deliberately. They are the source of truth for a
one-time import, they are small (~45 KB total), and provenance for
league-supplied data belongs in the repo rather than in someone's Downloads
folder.

## Files

| File | Consumed by | Notes |
|---|---|---|
| `Teams.xlsx` | `scripts/whsbla-extract.py` → `scripts/import-whsbla.js` | Sheet `Teams`, 127 rows. 75 untagged = WHSBLA members; 52 `(XX)`-tagged = out-of-state opponents. `San Marcos SD (CA)` appears twice; the extractor dedupes to 51 and reports it. |
| `2026-WHSBLA-Varsity-(Lacrosse)-Schedule.xlsx` | same | Sheet `WBLA Schedule`, 531 rows, 2026-03-13 → 2026-05-23. |
| `Classifications-2027-draft.xlsx` | **not yet imported** — seeds season **2027** | Sheet `Teams`, 76 teams, all classified. Brandon's draft; final version expected **end of October 2026**. |
| `alias-decisions.json` | `scripts/import-whsbla.js` | Human alias rulings with approver + evidence. |

### Schedule sheet — column trap

The header has **duplicate names**:

```
('Date','Time','Away','Home','Away','Home','Location','Type','Notation')
```

Columns 2/3 are team **names**; 4/5 are **scores**. Both pairs are labelled
`Away`/`Home`. Name-based column lookup silently returns the wrong column —
the extractor uses positional access only.

`Time` cells are Excel time serials rendered as `datetime(1900,1,1,H,M)`.
`Notation` has four values, not two: `Overtime`, `Forfeit`, `One Referee`,
`No Referees`.

## Membership is league-defined, never geographic

The untagged `Teams.xlsx` list **is** the membership filter. **Hermiston** is an
Oregon-located WIAA school that competes in WHSBLA and is untagged. Do not
geo-filter. Conversely `Aloha (OR)`, `Bend-Calderra (OR)` and `Clackamas (OR)`
are tagged — they are Oregon opponents, not members, and resolve to existing
Oregon teams via `alias-decisions.json`.

`Bend-Calderra` is a transcription error in the export (`Calderra` has a doubled
r). Recorded as an alias with that evidence rather than creating a duplicate.

## Classification is per-season — 2026 is NOT wrong

2026 classification came from the LaxNumbers class pages
(`v=3582` 4A, `3583` 3A, `3584` 2A, `3585` Private/Open) and is stored as
`source='laxnumbers_provisional'`.

Brandon's 2027 draft shows 17 teams moving out of `PV/OPEN`. That looked at
first like the provisional data being wrong. **It is not.** The 2026 playoff
bracket bucketed by that exact classification produced four perfect
single-elimination trees — n teams / n−1 games, one intra-class final each,
including `wa_private` at 16 teams / 15 games. Seventeen misclassified teams
could not produce that result.

The likelier reading: WHSBLA's Open division historically absorbed public
schools that opted in, and **2027 is a real realignment.** So:

- **2026** keeps `laxnumbers_provisional` — bracket-validated, do not rewrite it
- **2027** is seeded from Brandon's draft as its own `team_seasons` rows
- the **October final supersedes wholesale for 2027 only**

This is exactly what the per-season `team_seasons.division_id` schema
anticipates. A classification is a fact about a team *in a season*.

## 2027 churn (draft vs 2026 actual)

```
adds:   1   Vashon -> 2A
drops:  0
real reclassification: North Kitsap 4A -> 2A

division shape        2026    2027(draft)
  4A                    27       38
  3A                    14       17
  2A                     6       10
  PV/OPEN               28       11
```

The 17 remaining `PV/OPEN → 4A/3A/2A` moves are the realignment described
above, not corrections. Re-diff against the October final before seeding 2027
for real.

## Known open item

**WHSBLA regions / conference groupings are not in these exports.** League and
division standings need them. Blocked pending a follow-up to Brandon.
