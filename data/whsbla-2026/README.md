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
| `2026-WHSBLA-Varsity-(Lacrosse)-Schedule.xlsx` | same | Sheet `WBLA Schedule`, **531 rows** (532 `<row>` elements incl. header), 2026-03-13 → 2026-05-23. **531 is a SHEET ROW COUNT, not a game count** — see the count ladder below before comparing it to anything. |
| `Classifications-2027-draft.xlsx` | **not yet imported** — seeds season **2027** | Sheet `Teams`, 76 teams, all classified. Brandon's draft; final version expected **end of October 2026**. |
| `alias-decisions.json` | `scripts/import-whsbla.js` | Human alias rulings with approver + evidence. |

## Count ladder — 531 sheet rows to 528 feed rows

Six games existed in BOTH sources, mirrored — same date, same pair, opposite home
side — because `uq_game` and the importer's ownership lookup were both
orientation-sensitive. They were collapsed to the OHSLA row with the orientation
disagreement logged to `source_conflicts`. See
`scripts/dedupe-mirrored-games.js` and `migrations/section-i-*`.

```
531  rows in the WHSBLA schedule sheet
  508  inserted           canonical_source = 'whsbla'
+  22  left to OHSLA      source precedence, both sources agreed on orientation
+   1  rejected out of scope
= 531                     zero unexplained rows

508  inserted
-   6  deleted as mirrored duplicates (all WHSBLA-side; OHSLA rows kept)
= 502  whsbla-sourced games remaining

856  total 2026 games  =  354 ohsla  +  502 whsbla

FEED COUNTS
  Oregon      360 -> 354   all 6 duplicates had an OR participant
  Washington  529 -> 528   only ONE did (nelson / richland_wa)
```

⚠️ **There is no "523".** An earlier note claimed 523 distinct WA matchups by
assuming all six duplicates sat in Washington's feed. Only one did — the other five
are Oregon teams against Nevada and BC opponents, with no WA participant. The WA feed
is **528**. The wrong figure was produced by reasoning about the data instead of
counting it, which is the same mistake the count-binds-to-rendered-rows rule exists
to prevent, one layer down.

Four records were inflated by the duplicates and are now correct:

```
nelson             15-4 -> 14-4        richland_wa   18-5 -> 18-4
bend_caldera        6-7 ->  6-6        faith_lutheran_nv  2-1 -> 1-1
```

A separate FIELD-level merge followed: WHSBLA had classified four of the six as
`exhibition` where OHSLA says `non_league`, and the scheduling league is authoritative
on what kind of game it was. Adopting that (`scripts/adopt-whsbla-game-types.js`)
restored `exhibition: 4` and re-excluded those games from records, moving six more
teams — grant 12-8 → 11-7, lakeridge 16-4 → 15-4, summit 9-7 → 9-6,
palo_verde_nv 3-1 → 2-0, nanaimo_bc 2-2 → 2-1, claremont_bc 2-2 → 1-2.

All of the above is asserted from outside the database by
`scripts/verify-record-parity.js`, whose oracle is hardcoded from these rulings
rather than queried — because the earlier parity check compared two consumers of the
same table and agreed while both double-counted.

⚠️ **The 2 `practice`-type games are NOT the delta.** They are *inside* the WA feed
and they DO render on the Scores board — they were played. They are excluded from
**records** only, by `is_scrimmage` / `game_type`, exactly like exhibitions.

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
