# Migration Runbook — Section C: Reference Data Seeding

---

## C1. Seed venues

> **⚠️ TRUNCATION NOTE:** This block was produced in a session where the output was truncated mid-INSERT and then restarted. Before executing, verify your saved copy has **one complete INSERT IGNORE block** — not two partial blocks. Scroll to the closing semicolon and confirm all 41 venue rows are present.

```sql
INSERT IGNORE INTO venues (name, city, state) VALUES
    ('OES',                    'Portland',     'OR'),
    ('Hood River HS',          'Hood River',   'OR'),
    ('Lincoln HS',             'Portland',     'OR'),
    ('Grant HS',               'Portland',     'OR'),
    ('Central Catholic HS',    'Portland',     'OR'),
    ('Ida B Wells-Barnett HS', 'Portland',     'OR'),
    ('Mt. View HS',            'Bend',         'OR'),
    ('Caldera HS',             'Bend',         'OR'),
    ('Burns HS',               'Burns',        'OR'),
    ('Summit HS',              'Bend',         'OR'),
    ('Aloha HS',               'Beaverton',    'OR'),
    ('Beaverton HS',           'Beaverton',    'OR'),
    ('Jesuit HS',              'Portland',     'OR'),
    ('Mountainside HS',        'Beaverton',    'OR'),
    ('Sunset HS',              'Beaverton',    'OR'),
    ('Westview HS',            'Beaverton',    'OR'),
    ('West Albany HS',         'Albany',       'OR'),
    ('West Salem HS',          'Salem',        'OR'),
    ('Crescent Valley HS',     'Corvallis',    'OR'),
    ('Sprague HS',             'Salem',        'OR'),
    ('Newberg HS',             'Newberg',      'OR'),
    ('Sherwood HS',            'Sherwood',     'OR'),
    ('Tigard HS',              'Tigard',       'OR'),
    ('Tualatin HS',            'Tualatin',     'OR'),
    ('Wilsonville HS',         'Wilsonville',  'OR'),
    ('Century HS',             'Hillsboro',    'OR'),
    ('Forest Grove HS',        'Forest Grove', 'OR'),
    ('Glencoe HS',             'Hillsboro',    'OR'),
    ('Hillsboro HS',           'Hillsboro',    'OR'),
    ('Liberty HS',             'Hillsboro',    'OR'),
    ('Roseburg HS',            'Roseburg',     'OR'),
    ('South Eugene HS',        'Eugene',       'OR'),
    ('Marist HS',              'Eugene',       'OR'),
    ('Sheldon HS',             'Eugene',       'OR'),
    ('Thurston HS',            'Springfield',  'OR'),
    ('Canby HS',               'Canby',        'OR'),
    ('Lakeridge HS',           'Lake Oswego',  'OR'),
    ('Clackamas HS',           'Clackamas',    'OR'),
    ('Oregon City HS',         'Oregon City',  'OR'),
    ('West Linn HS',           'West Linn',    'OR'),
    ('Lake Oswego HS',         'Lake Oswego',  'OR');
```

```sql
-- Verify
SELECT COUNT(*) AS venue_count FROM venues;
-- Expected: 41
```

Expected output: `venue_count = 41`.

**GO:** Count = 41.
**NO-GO:** Count < 41 — a row was rejected. Run `SELECT name, city, COUNT(*) FROM venues GROUP BY name, city HAVING COUNT(*) > 1;` to check for unexpected duplicates against the UNIQUE KEY `uq_venues_name_city`.
If this fails: Identify which name+city pair already existed in the venues table (should be empty after B4), fix the conflict, and re-run.

---

## C2. Seed Oregon teams

What to do: Insert all 41 Oregon program rows. `home_venue_id` is left NULL here and linked in C4.

```sql
INSERT IGNORE INTO teams (slug, name, mascot, city, state) VALUES
    ('oes',              'Oregon Episcopal',          'Aardvarks',    'Portland',     'OR'),
    ('hood_river',       'Hood River',                'Eagles',       'Hood River',   'OR'),
    ('lincoln',          'Lincoln',                   'Cardinals',    'Portland',     'OR'),
    ('grant',            'Grant/Central Eastside',    'Generals',     'Portland',     'OR'),
    ('central_catholic', 'Central Catholic',          'Rams',         'Portland',     'OR'),
    ('ida_b_wells',      'Ida B Wells',               'Ducks',        'Portland',     'OR'),
    ('mt_view',          'Mountain View',             'Cougars',      'Bend',         'OR'),
    ('bend_caldera',     'Bend/Caldera',              'Lava Bears',   'Bend',         'OR'),
    ('burns',            'Burns',                     'Hilanders',    'Burns',        'OR'),
    ('summit',           'Summit',                    'Storm',        'Bend',         'OR'),
    ('aloha_southridge', 'Aloha/Southridge',          'Warriors',     'Beaverton',    'OR'),
    ('beaverton',        'Beaverton',                 'Beavers',      'Beaverton',    'OR'),
    ('jesuit',           'Jesuit Portland',           'Crusaders',    'Portland',     'OR'),
    ('mountainside',     'Mountainside',              'Mavericks',    'Beaverton',    'OR'),
    ('sunset',           'Sunset',                    'Apollos',      'Beaverton',    'OR'),
    ('westview',         'Westview',                  'Wildcats',     'Beaverton',    'OR'),
    ('west_albany',      'West Albany',               'Bulldogs',     'Albany',       'OR'),
    ('west_salem',       'West Salem/McNary',         'Titans',       'Salem',        'OR'),
    ('corvallis',        'Corvallis/Crescent Valley', 'Eagles',       'Corvallis',    'OR'),
    ('sprague',          'Sprague/South Salem',       'Olympians',    'Salem',        'OR'),
    ('newberg',          'Newberg',                   'Tigers',       'Newberg',      'OR'),
    ('sherwood',         'Sherwood',                  'Bowmen',       'Sherwood',     'OR'),
    ('tigard',           'Tigard',                    'Tigers',       'Tigard',       'OR'),
    ('tualatin',         'Tualatin',                  'Timberwolves', 'Tualatin',     'OR'),
    ('wilsonville',      'Wilsonville',               'Wildcats',     'Wilsonville',  'OR'),
    ('century',          'Century',                   'Jaguars',      'Hillsboro',    'OR'),
    ('forest_grove',     'Forest Grove',              'Vikings',      'Forest Grove', 'OR'),
    ('glencoe',          'Glencoe',                   'Crimson Tide', 'Hillsboro',    'OR'),
    ('hillsboro',        'Hillsboro',                 'Spartans',     'Hillsboro',    'OR'),
    ('liberty',          'Liberty',                   'Falcons',      'Hillsboro',    'OR'),
    ('roseburg',         'Roseburg',                  'Indians',      'Roseburg',     'OR'),
    ('south_eugene',     'South Eugene',              'Axemen',       'Eugene',       'OR'),
    ('marist',           'Marist',                    'Spartans',     'Eugene',       'OR'),
    ('sheldon',          'Sheldon',                   'Irish',        'Eugene',       'OR'),
    ('thurston',         'Thurston',                  'Colts',        'Springfield',  'OR'),
    ('canby',            'Canby',                     'Cougars',      'Canby',        'OR'),
    ('lakeridge',        'Lakeridge',                 'Pacers',       'Lake Oswego',  'OR'),
    ('nelson',           'Clackamas/Nelson',          'Cavaliers',    'Clackamas',    'OR'),
    ('oregon_city',      'Oregon City',               'Pioneers',     'Oregon City',  'OR'),
    ('west_linn',        'West Linn',                 'Lions',        'West Linn',    'OR'),
    ('lake_oswego',      'Lake Oswego/Riverdale',     'Lakers',       'Lake Oswego',  'OR');
```

```sql
-- Verify
SELECT COUNT(*) AS oregon_team_count FROM teams WHERE state = 'OR';
-- Expected: 41
```

Expected output: `oregon_team_count = 41`.

**GO:** Count = 41.
**NO-GO:** Count < 41.
If this fails: Run `SELECT slug FROM teams WHERE state = 'OR' ORDER BY slug;` and diff against the 41 slugs above to find which row was rejected by the UNIQUE KEY on slug.

---

## C3. Seed out-of-state placeholder teams and their aliases

What to do: Insert one placeholder team row per out-of-state opponent identified in A7, then seed their aliases so D1's JOIN can resolve the raw opponent strings from the old games table.

> **Expected scope: approximately 32 out-of-state teams.** The `borah` entry below is the one confirmed from MockData. The full list is determined by A7's `SELECT DISTINCT opponent FROM games_v1` output. Typical out-of-state opponents in Oregon lacrosse schedules include schools from Idaho (Boise-area programs), Washington (Clark County and Tri-Cities programs), California, and Utah. Add one block per team found in A7 before running this step. Do not skip this step or defer it — any out-of-state opponent without an alias row will be silently dropped by D1's JOIN.

```sql
-- One block per out-of-state team. Add additional blocks from A7 output.
-- borah — Borah High School, Boise, ID
INSERT IGNORE INTO teams (slug, name, city, state) VALUES
    ('borah', 'Borah HS', 'Boise', 'ID');

INSERT IGNORE INTO team_aliases (team_id, alias, source)
SELECT id, 'borah',         'mockdata' FROM teams WHERE slug = 'borah' UNION ALL
SELECT id, 'Borah HS',      'mockdata' FROM teams WHERE slug = 'borah' UNION ALL
SELECT id, 'Borah HS (ID)', 'mockdata' FROM teams WHERE slug = 'borah';
```

```sql
-- Template for each additional out-of-state team from A7:
-- INSERT IGNORE INTO teams (slug, name, city, state) VALUES
--     ('<slug>', '<name>', '<city>', '<state_code>');
--
-- INSERT IGNORE INTO team_aliases (team_id, alias, source)
-- SELECT id, '<slug>',         'mockdata' FROM teams WHERE slug = '<slug>' UNION ALL
-- SELECT id, '<display name>', 'mockdata' FROM teams WHERE slug = '<slug>' UNION ALL
-- SELECT id, '<raw string as it appears in old games.opponent>', 'mockdata'
--     FROM teams WHERE slug = '<slug>';
```

```sql
-- Verify: total teams including out-of-state
SELECT state, COUNT(*) AS cnt FROM teams GROUP BY state ORDER BY cnt DESC;
-- Expected: OR = 41, plus one row per out-of-state state code (e.g. ID = 1)
```

Expected output: `OR = 41`. Each out-of-state state code appears with its expected count.

**GO:** All out-of-state teams from A7 are present. Alias count for each equals the number of raw strings that appeared in the old games table for that opponent.
**NO-GO:** Any out-of-state team from A7 is missing.
If this fails: Add the missing block using the template above and re-run.

---

## C4. Link Oregon teams to home venues

What to do: Set `home_venue_id` on all 41 Oregon team rows via a single UPDATE that joins on the slug-to-venue-name mapping.

> **⚠️ VERIFICATION IS LOAD-BEARING.** The CASE expression below must cover all 41 Oregon slugs. Any slug not listed causes CASE to return NULL; the JOIN ON `v.name = NULL` condition is never true, so that team gets no `home_venue_id`. Consequence: games for that team cannot record a home venue in the new schema, and D1 leaves `venue_id = NULL` for their home games. Before executing, count the WHEN arms and confirm all 41 slugs are present.

```sql
UPDATE teams t
JOIN venues v ON v.name = CASE t.slug
    WHEN 'oes'              THEN 'OES'
    WHEN 'hood_river'       THEN 'Hood River HS'
    WHEN 'lincoln'          THEN 'Lincoln HS'
    WHEN 'grant'            THEN 'Grant HS'
    WHEN 'central_catholic' THEN 'Central Catholic HS'
    WHEN 'ida_b_wells'      THEN 'Ida B Wells-Barnett HS'
    WHEN 'mt_view'          THEN 'Mt. View HS'
    WHEN 'bend_caldera'     THEN 'Caldera HS'
    WHEN 'burns'            THEN 'Burns HS'
    WHEN 'summit'           THEN 'Summit HS'
    WHEN 'aloha_southridge' THEN 'Aloha HS'
    WHEN 'beaverton'        THEN 'Beaverton HS'
    WHEN 'jesuit'           THEN 'Jesuit HS'
    WHEN 'mountainside'     THEN 'Mountainside HS'
    WHEN 'sunset'           THEN 'Sunset HS'
    WHEN 'westview'         THEN 'Westview HS'
    WHEN 'west_albany'      THEN 'West Albany HS'
    WHEN 'west_salem'       THEN 'West Salem HS'
    WHEN 'corvallis'        THEN 'Crescent Valley HS'
    WHEN 'sprague'          THEN 'Sprague HS'
    WHEN 'newberg'          THEN 'Newberg HS'
    WHEN 'sherwood'         THEN 'Sherwood HS'
    WHEN 'tigard'           THEN 'Tigard HS'
    WHEN 'tualatin'         THEN 'Tualatin HS'
    WHEN 'wilsonville'      THEN 'Wilsonville HS'
    WHEN 'century'          THEN 'Century HS'
    WHEN 'forest_grove'     THEN 'Forest Grove HS'
    WHEN 'glencoe'          THEN 'Glencoe HS'
    WHEN 'hillsboro'        THEN 'Hillsboro HS'
    WHEN 'liberty'          THEN 'Liberty HS'
    WHEN 'roseburg'         THEN 'Roseburg HS'
    WHEN 'south_eugene'     THEN 'South Eugene HS'
    WHEN 'marist'           THEN 'Marist HS'
    WHEN 'sheldon'          THEN 'Sheldon HS'
    WHEN 'thurston'         THEN 'Thurston HS'
    WHEN 'canby'            THEN 'Canby HS'
    WHEN 'lakeridge'        THEN 'Lakeridge HS'
    WHEN 'nelson'           THEN 'Clackamas HS'
    WHEN 'oregon_city'      THEN 'Oregon City HS'
    WHEN 'west_linn'        THEN 'West Linn HS'
    WHEN 'lake_oswego'      THEN 'Lake Oswego HS'
END
SET t.home_venue_id = v.id
WHERE t.state = 'OR';
```

```sql
-- Verify: no Oregon team should have a NULL home_venue_id
SELECT slug FROM teams WHERE state = 'OR' AND home_venue_id IS NULL;
-- Expected: 0 rows

-- Spot-check one team
SELECT t.slug, t.name, v.name AS venue, v.city
FROM teams t
JOIN venues v ON v.id = t.home_venue_id
WHERE t.slug = 'mt_view';
-- Expected: mt_view | Mountain View | Mt. View HS | Bend
```

Expected output: Zero rows in the NULL check. Spot-check shows correct venue name and city.

**GO:** Zero Oregon teams with NULL `home_venue_id`. Spot-check correct.
**NO-GO:** Any Oregon team has NULL `home_venue_id`.
If this fails: Run `SELECT slug FROM teams WHERE state = 'OR' AND home_venue_id IS NULL;` to identify which slug had no matching venue. Confirm the venue name in the CASE matches exactly (case-sensitive) the name inserted in C1.

---

## C5. Seed team_aliases for all Oregon teams

What to do: Insert slug, display name, and all explicit MockData aliases for every Oregon team. `INSERT IGNORE` handles cases where an alias normalizes to the same value as the slug (e.g., `'OES'` → `'oes'` conflicts with slug alias `'oes'` and is silently skipped — correct behavior).

```sql
INSERT IGNORE INTO team_aliases (team_id, alias, source)
-- ── oes ──────────────────────────────────────────────────────────────────
SELECT id, 'oes',                       'mockdata' FROM teams WHERE slug = 'oes' UNION ALL
SELECT id, 'Oregon Episcopal',          'mockdata' FROM teams WHERE slug = 'oes' UNION ALL
SELECT id, 'OES',                       'mockdata' FROM teams WHERE slug = 'oes' UNION ALL
SELECT id, 'Oregon Episcopal School',   'mockdata' FROM teams WHERE slug = 'oes' UNION ALL
-- ── hood_river ───────────────────────────────────────────────────────────
SELECT id, 'hood_river',                'mockdata' FROM teams WHERE slug = 'hood_river' UNION ALL
SELECT id, 'Hood River',                'mockdata' FROM teams WHERE slug = 'hood_river' UNION ALL
-- ── lincoln ──────────────────────────────────────────────────────────────
SELECT id, 'lincoln',                   'mockdata' FROM teams WHERE slug = 'lincoln' UNION ALL
SELECT id, 'Lincoln',                   'mockdata' FROM teams WHERE slug = 'lincoln' UNION ALL
-- ── grant ────────────────────────────────────────────────────────────────
SELECT id, 'grant',                     'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
SELECT id, 'Grant/Central Eastside',    'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
SELECT id, 'grant_central',             'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
SELECT id, 'Grant - Central Eastside',  'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
SELECT id, 'Grant Central Eastside',    'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
SELECT id, 'Grant',                     'mockdata' FROM teams WHERE slug = 'grant' UNION ALL
-- ── central_catholic ─────────────────────────────────────────────────────
SELECT id, 'central_catholic',          'mockdata' FROM teams WHERE slug = 'central_catholic' UNION ALL
SELECT id, 'Central Catholic',          'mockdata' FROM teams WHERE slug = 'central_catholic' UNION ALL
-- ── ida_b_wells ──────────────────────────────────────────────────────────
SELECT id, 'ida_b_wells',               'mockdata' FROM teams WHERE slug = 'ida_b_wells' UNION ALL
SELECT id, 'Ida B Wells',               'mockdata' FROM teams WHERE slug = 'ida_b_wells' UNION ALL
-- ── mt_view ──────────────────────────────────────────────────────────────
SELECT id, 'mt_view',                   'mockdata' FROM teams WHERE slug = 'mt_view' UNION ALL
SELECT id, 'Mountain View',             'mockdata' FROM teams WHERE slug = 'mt_view' UNION ALL
SELECT id, 'Mt. View',                  'mockdata' FROM teams WHERE slug = 'mt_view' UNION ALL
SELECT id, 'Mt View',                   'mockdata' FROM teams WHERE slug = 'mt_view' UNION ALL
SELECT id, 'mt view',                   'mockdata' FROM teams WHERE slug = 'mt_view' UNION ALL
-- ── bend_caldera ─────────────────────────────────────────────────────────
SELECT id, 'bend_caldera',              'mockdata' FROM teams WHERE slug = 'bend_caldera' UNION ALL
SELECT id, 'Bend/Caldera',              'mockdata' FROM teams WHERE slug = 'bend_caldera' UNION ALL
SELECT id, 'Bend - Caldera',            'mockdata' FROM teams WHERE slug = 'bend_caldera' UNION ALL
SELECT id, 'Bend Caldera',              'mockdata' FROM teams WHERE slug = 'bend_caldera' UNION ALL
SELECT id, 'Bend/Caldera HS',           'mockdata' FROM teams WHERE slug = 'bend_caldera' UNION ALL
-- ── burns ────────────────────────────────────────────────────────────────
SELECT id, 'burns',                     'mockdata' FROM teams WHERE slug = 'burns' UNION ALL
SELECT id, 'Burns',                     'mockdata' FROM teams WHERE slug = 'burns' UNION ALL
-- ── summit ───────────────────────────────────────────────────────────────
SELECT id, 'summit',                    'mockdata' FROM teams WHERE slug = 'summit' UNION ALL
SELECT id, 'Summit',                    'mockdata' FROM teams WHERE slug = 'summit' UNION ALL
-- ── aloha_southridge ─────────────────────────────────────────────────────
SELECT id, 'aloha_southridge',          'mockdata' FROM teams WHERE slug = 'aloha_southridge' UNION ALL
SELECT id, 'Aloha/Southridge',          'mockdata' FROM teams WHERE slug = 'aloha_southridge' UNION ALL
SELECT id, 'Aloha - Southridge',        'mockdata' FROM teams WHERE slug = 'aloha_southridge' UNION ALL
SELECT id, 'Aloha Southridge',          'mockdata' FROM teams WHERE slug = 'aloha_southridge' UNION ALL
-- ── beaverton ────────────────────────────────────────────────────────────
SELECT id, 'beaverton',                 'mockdata' FROM teams WHERE slug = 'beaverton' UNION ALL
SELECT id, 'Beaverton',                 'mockdata' FROM teams WHERE slug = 'beaverton' UNION ALL
-- ── jesuit ───────────────────────────────────────────────────────────────
SELECT id, 'jesuit',                    'mockdata' FROM teams WHERE slug = 'jesuit' UNION ALL
SELECT id, 'Jesuit Portland',           'mockdata' FROM teams WHERE slug = 'jesuit' UNION ALL
SELECT id, 'Jesuit',                    'mockdata' FROM teams WHERE slug = 'jesuit' UNION ALL
SELECT id, 'Jesuit HS',                 'mockdata' FROM teams WHERE slug = 'jesuit' UNION ALL
-- ── mountainside ─────────────────────────────────────────────────────────
SELECT id, 'mountainside',              'mockdata' FROM teams WHERE slug = 'mountainside' UNION ALL
SELECT id, 'Mountainside',              'mockdata' FROM teams WHERE slug = 'mountainside' UNION ALL
-- ── sunset ───────────────────────────────────────────────────────────────
SELECT id, 'sunset',                    'mockdata' FROM teams WHERE slug = 'sunset' UNION ALL
SELECT id, 'Sunset',                    'mockdata' FROM teams WHERE slug = 'sunset' UNION ALL
-- ── westview ─────────────────────────────────────────────────────────────
SELECT id, 'westview',                  'mockdata' FROM teams WHERE slug = 'westview' UNION ALL
SELECT id, 'Westview',                  'mockdata' FROM teams WHERE slug = 'westview' UNION ALL
-- ── west_albany ──────────────────────────────────────────────────────────
SELECT id, 'west_albany',               'mockdata' FROM teams WHERE slug = 'west_albany' UNION ALL
SELECT id, 'West Albany',               'mockdata' FROM teams WHERE slug = 'west_albany' UNION ALL
-- ── west_salem ───────────────────────────────────────────────────────────
SELECT id, 'west_salem',                'mockdata' FROM teams WHERE slug = 'west_salem' UNION ALL
SELECT id, 'West Salem/McNary',         'mockdata' FROM teams WHERE slug = 'west_salem' UNION ALL
SELECT id, 'West Salem - McNary',       'mockdata' FROM teams WHERE slug = 'west_salem' UNION ALL
SELECT id, 'West Salem McNary',         'mockdata' FROM teams WHERE slug = 'west_salem' UNION ALL
SELECT id, 'West Salem',                'mockdata' FROM teams WHERE slug = 'west_salem' UNION ALL
-- ── corvallis ────────────────────────────────────────────────────────────
SELECT id, 'corvallis',                 'mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
SELECT id, 'Corvallis/Crescent Valley', 'mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
SELECT id, 'Corvallis - Crescent Valley','mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
SELECT id, 'Corvallis Crescent Valley', 'mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
SELECT id, 'Crescent Valley',           'mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
SELECT id, 'Corvallis',                 'mockdata' FROM teams WHERE slug = 'corvallis' UNION ALL
-- ── sprague ──────────────────────────────────────────────────────────────
SELECT id, 'sprague',                   'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'Sprague/South Salem',       'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'Sprague - South Salem',     'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'Sprague South Salem',       'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'Sprague HS',                'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'South Salem',               'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
SELECT id, 'Sprague',                   'mockdata' FROM teams WHERE slug = 'sprague' UNION ALL
-- ── newberg ──────────────────────────────────────────────────────────────
SELECT id, 'newberg',                   'mockdata' FROM teams WHERE slug = 'newberg' UNION ALL
SELECT id, 'Newberg',                   'mockdata' FROM teams WHERE slug = 'newberg' UNION ALL
-- ── sherwood ─────────────────────────────────────────────────────────────
SELECT id, 'sherwood',                  'mockdata' FROM teams WHERE slug = 'sherwood' UNION ALL
SELECT id, 'Sherwood',                  'mockdata' FROM teams WHERE slug = 'sherwood' UNION ALL
-- ── tigard ───────────────────────────────────────────────────────────────
SELECT id, 'tigard',                    'mockdata' FROM teams WHERE slug = 'tigard' UNION ALL
SELECT id, 'Tigard',                    'mockdata' FROM teams WHERE slug = 'tigard' UNION ALL
-- ── tualatin ─────────────────────────────────────────────────────────────
SELECT id, 'tualatin',                  'mockdata' FROM teams WHERE slug = 'tualatin' UNION ALL
SELECT id, 'Tualatin',                  'mockdata' FROM teams WHERE slug = 'tualatin' UNION ALL
-- ── wilsonville ──────────────────────────────────────────────────────────
SELECT id, 'wilsonville',               'mockdata' FROM teams WHERE slug = 'wilsonville' UNION ALL
SELECT id, 'Wilsonville',               'mockdata' FROM teams WHERE slug = 'wilsonville' UNION ALL
-- ── century ──────────────────────────────────────────────────────────────
SELECT id, 'century',                   'mockdata' FROM teams WHERE slug = 'century' UNION ALL
SELECT id, 'Century',                   'mockdata' FROM teams WHERE slug = 'century' UNION ALL
-- ── forest_grove ─────────────────────────────────────────────────────────
SELECT id, 'forest_grove',              'mockdata' FROM teams WHERE slug = 'forest_grove' UNION ALL
SELECT id, 'Forest Grove',              'mockdata' FROM teams WHERE slug = 'forest_grove' UNION ALL
-- ── glencoe ──────────────────────────────────────────────────────────────
SELECT id, 'glencoe',                   'mockdata' FROM teams WHERE slug = 'glencoe' UNION ALL
SELECT id, 'Glencoe',                   'mockdata' FROM teams WHERE slug = 'glencoe' UNION ALL
-- ── hillsboro ────────────────────────────────────────────────────────────
SELECT id, 'hillsboro',                 'mockdata' FROM teams WHERE slug = 'hillsboro' UNION ALL
SELECT id, 'Hillsboro',                 'mockdata' FROM teams WHERE slug = 'hillsboro' UNION ALL
-- ── liberty ──────────────────────────────────────────────────────────────
SELECT id, 'liberty',                   'mockdata' FROM teams WHERE slug = 'liberty' UNION ALL
SELECT id, 'Liberty',                   'mockdata' FROM teams WHERE slug = 'liberty' UNION ALL
-- ── roseburg ─────────────────────────────────────────────────────────────
SELECT id, 'roseburg',                  'mockdata' FROM teams WHERE slug = 'roseburg' UNION ALL
SELECT id, 'Roseburg',                  'mockdata' FROM teams WHERE slug = 'roseburg' UNION ALL
-- ── south_eugene ─────────────────────────────────────────────────────────
SELECT id, 'south_eugene',              'mockdata' FROM teams WHERE slug = 'south_eugene' UNION ALL
SELECT id, 'South Eugene',              'mockdata' FROM teams WHERE slug = 'south_eugene' UNION ALL
-- ── marist ───────────────────────────────────────────────────────────────
SELECT id, 'marist',                    'mockdata' FROM teams WHERE slug = 'marist' UNION ALL
SELECT id, 'Marist',                    'mockdata' FROM teams WHERE slug = 'marist' UNION ALL
-- ── sheldon ──────────────────────────────────────────────────────────────
SELECT id, 'sheldon',                   'mockdata' FROM teams WHERE slug = 'sheldon' UNION ALL
SELECT id, 'Sheldon',                   'mockdata' FROM teams WHERE slug = 'sheldon' UNION ALL
-- ── thurston ─────────────────────────────────────────────────────────────
SELECT id, 'thurston',                  'mockdata' FROM teams WHERE slug = 'thurston' UNION ALL
SELECT id, 'Thurston',                  'mockdata' FROM teams WHERE slug = 'thurston' UNION ALL
-- ── canby ────────────────────────────────────────────────────────────────
SELECT id, 'canby',                     'mockdata' FROM teams WHERE slug = 'canby' UNION ALL
SELECT id, 'Canby',                     'mockdata' FROM teams WHERE slug = 'canby' UNION ALL
-- ── lakeridge ────────────────────────────────────────────────────────────
SELECT id, 'lakeridge',                 'mockdata' FROM teams WHERE slug = 'lakeridge' UNION ALL
SELECT id, 'Lakeridge',                 'mockdata' FROM teams WHERE slug = 'lakeridge' UNION ALL
-- ── nelson ───────────────────────────────────────────────────────────────
SELECT id, 'nelson',                    'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'Clackamas/Nelson',          'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'clackamas_nelson',          'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'Nelson - Clackamas',        'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'Nelson Clackamas',          'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'Clackamas Nelson',          'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
SELECT id, 'Nelson',                    'mockdata' FROM teams WHERE slug = 'nelson' UNION ALL
-- ── oregon_city ──────────────────────────────────────────────────────────
SELECT id, 'oregon_city',               'mockdata' FROM teams WHERE slug = 'oregon_city' UNION ALL
SELECT id, 'Oregon City',               'mockdata' FROM teams WHERE slug = 'oregon_city' UNION ALL
-- ── west_linn ────────────────────────────────────────────────────────────
SELECT id, 'west_linn',                 'mockdata' FROM teams WHERE slug = 'west_linn' UNION ALL
SELECT id, 'West Linn',                 'mockdata' FROM teams WHERE slug = 'west_linn' UNION ALL
-- ── lake_oswego ──────────────────────────────────────────────────────────
SELECT id, 'lake_oswego',               'mockdata' FROM teams WHERE slug = 'lake_oswego' UNION ALL
SELECT id, 'Lake Oswego/Riverdale',     'mockdata' FROM teams WHERE slug = 'lake_oswego' UNION ALL
SELECT id, 'Lake Oswego - Riverdale',   'mockdata' FROM teams WHERE slug = 'lake_oswego' UNION ALL
SELECT id, 'Lake Oswego Riverdale',     'mockdata' FROM teams WHERE slug = 'lake_oswego' UNION ALL
SELECT id, 'Lake Oswego',               'mockdata' FROM teams WHERE slug = 'lake_oswego' UNION ALL
SELECT id, 'Riverdale',                 'mockdata' FROM teams WHERE slug = 'lake_oswego';
```

```sql
-- Verify: every Oregon team has at least 2 aliases (slug + name minimum)
SELECT t.slug, COUNT(ta.id) AS alias_count
FROM teams t
JOIN team_aliases ta ON ta.team_id = t.id
WHERE t.state = 'OR'
GROUP BY t.slug
HAVING COUNT(ta.id) < 2;
-- Expected: 0 rows

SELECT COUNT(*) AS total_oregon_aliases
FROM team_aliases ta
JOIN teams t ON t.id = ta.team_id
WHERE t.state = 'OR';
-- Expected: >= 100 (exact count depends on INSERT IGNORE deduplication)
```

Expected output: Zero rows in the first query. Total alias count ≥ 100.

**GO:** Zero teams with fewer than 2 aliases. Total alias count ≥ 100.
**NO-GO:** Any team has fewer than 2 aliases.
If this fails: Identify the team from the first query output, check that its slug exists in the teams table (C2 must have completed successfully), and re-run only that team's alias block.

---

## C6. Seed team_seasons for 2026

> **⚠️ PRE-EXECUTION CHECK:** Cross-check the conference assignments below against the current ohsla.net conference roster before running. OHSLA occasionally reorganizes conferences between seasons, and team co-ops (e.g., `aloha_southridge`, `west_salem`, `corvallis`, `sprague`, `nelson`, `lake_oswego`) may change their conference affiliation year-to-year. The assignments below reflect the 2026 season as known at runbook-authoring time.

What to do: Insert one `team_seasons` row per Oregon team for season 2026 with the correct conference. W-L starts at 0 and will be recomputed in D6.

```sql
INSERT IGNORE INTO team_seasons (team_id, season, conference)
SELECT t.id, 2026, 'Columbia'
FROM teams t WHERE t.slug IN (
    'oes', 'hood_river', 'lincoln', 'grant', 'central_catholic', 'ida_b_wells'
)
UNION ALL
SELECT t.id, 2026, 'High Desert'
FROM teams t WHERE t.slug IN (
    'mt_view', 'bend_caldera', 'burns', 'summit'
)
UNION ALL
SELECT t.id, 2026, 'Metro'
FROM teams t WHERE t.slug IN (
    'aloha_southridge', 'beaverton', 'jesuit', 'mountainside', 'sunset', 'westview'
)
UNION ALL
SELECT t.id, 2026, 'North Valley'
FROM teams t WHERE t.slug IN (
    'west_albany', 'west_salem', 'corvallis', 'sprague'
)
UNION ALL
SELECT t.id, 2026, 'Northwest'
FROM teams t WHERE t.slug IN (
    'newberg', 'sherwood', 'tigard', 'tualatin', 'wilsonville'
)
UNION ALL
SELECT t.id, 2026, 'Pacific'
FROM teams t WHERE t.slug IN (
    'century', 'forest_grove', 'glencoe', 'hillsboro', 'liberty'
)
UNION ALL
SELECT t.id, 2026, 'Southwest'
FROM teams t WHERE t.slug IN (
    'roseburg', 'south_eugene', 'marist', 'sheldon', 'thurston'
)
UNION ALL
SELECT t.id, 2026, 'Three Rivers'
FROM teams t WHERE t.slug IN (
    'canby', 'lakeridge', 'nelson', 'oregon_city', 'west_linn', 'lake_oswego'
);
```

```sql
-- Verify
SELECT conference, COUNT(*) AS teams
FROM team_seasons
WHERE season = 2026
GROUP BY conference
ORDER BY conference;
-- Expected: 8 rows matching the conference sizes above

SELECT COUNT(*) AS total FROM team_seasons WHERE season = 2026;
-- Expected: 41
```

Expected output: 8 conference rows with counts: Columbia=6, High Desert=4, Metro=6, North Valley=4, Northwest=5, Pacific=5, Southwest=5, Three Rivers=6. Total=41.

**GO:** All 8 conferences present with correct counts. Total = 41.
**NO-GO:** Any conference missing or total ≠ 41.
If this fails: Cross-reference missing slugs against the C2 teams INSERT. A slug not in the teams table will produce zero rows from the subquery and silently skip.

---

## C7. Seed coaches and team_coaches (NON-IDEMPOTENT)

What to do: Insert the one coaching staff with known names from MockData (mt_view). All other teams have `headCoach = "TBD"` in MockData and are intentionally skipped — the OHSLA scraper will populate them.

> **⚠ NON-IDEMPOTENT.** The `coaches` table has no UNIQUE constraint (append-only by design). Running this step twice creates duplicate coach rows. The `team_coaches` UNIQUE KEY prevents duplicate links, but duplicate coach rows cannot be cleaned up without knowing which `id` to delete. Run this step **exactly once**, and only when `coaches` is empty.

```sql
-- Safety check — must return 0 before proceeding
SELECT COUNT(*) AS existing_coaches FROM coaches;
```

**If count > 0, stop. Do not run C7.**
Investigate why rows are present before continuing. Possible causes: this step was already run, or the OHSLA scraper has already populated coaches. Either way, do not proceed without understanding the source of those rows.

If count = 0, continue:

```sql
INSERT INTO coaches (full_name) VALUES
    ('Charles Raub'),
    ('John McGuire'),
    ('Mason Ludwig'),
    ('Kyle Cardinal');

INSERT IGNORE INTO team_coaches (team_id, coach_id, season, role, source)
SELECT t.id, c.id, 2026, 'head', 'mockdata'
FROM teams t
JOIN coaches c ON c.full_name = 'Charles Raub'
WHERE t.slug = 'mt_view';

INSERT IGNORE INTO team_coaches (team_id, coach_id, season, role, source)
SELECT t.id, c.id, 2026, 'assistant', 'mockdata'
FROM teams t
JOIN coaches c ON c.full_name = 'John McGuire'
WHERE t.slug = 'mt_view';

INSERT IGNORE INTO team_coaches (team_id, coach_id, season, role, source)
SELECT t.id, c.id, 2026, 'assistant', 'mockdata'
FROM teams t
JOIN coaches c ON c.full_name = 'Mason Ludwig'
WHERE t.slug = 'mt_view';

INSERT IGNORE INTO team_coaches (team_id, coach_id, season, role, source)
SELECT t.id, c.id, 2026, 'assistant', 'mockdata'
FROM teams t
JOIN coaches c ON c.full_name = 'Kyle Cardinal'
WHERE t.slug = 'mt_view';
```

```sql
-- Verify
SELECT COUNT(*) AS coach_count FROM coaches;
-- Expected: 4

SELECT tc.role, c.full_name, t.slug
FROM team_coaches tc
JOIN coaches c ON c.id = tc.coach_id
JOIN teams t ON t.id = tc.team_id
WHERE t.slug = 'mt_view' AND tc.season = 2026
ORDER BY tc.role, c.full_name;
-- Expected: 4 rows — 1 head (Charles Raub), 3 assistants
```

Expected output: `coach_count = 4`. Four team_coaches rows for mt_view with correct roles.

**GO:** Count = 4. All four coaches linked to mt_view with correct roles.
**NO-GO:** `existing_coaches` was > 0 before running, or count ≠ 4 after.
If this fails: If you accidentally ran this twice, identify the duplicate coach ids (`SELECT full_name, COUNT(*) FROM coaches GROUP BY full_name HAVING COUNT(*) > 1`) and delete the duplicate rows by id before re-linking team_coaches.

---

## C8. End-to-end alias resolution spot-tests

What to do: Confirm the alias table resolves the exact raw strings that D1's backfill JOINs will encounter in the old games table — both the `team_id` column (slug) and the `opponent` column (display name variants).

```sql
-- Each lookup below must return exactly one row.
-- These mirror D1's JOIN:
--   JOIN team_aliases ON alias_normalized = LOWER(TRIM(raw_value))

SELECT
    LOWER(TRIM(raw.val))           AS looked_up,
    t.slug                         AS resolved_slug,
    t.name                         AS resolved_name
FROM (
    SELECT 'mt_view'           AS val UNION ALL  -- slug from old games.team_id
    SELECT 'Mountain View'          UNION ALL  -- display name from old games.opponent
    SELECT 'Mt. View'               UNION ALL  -- alias variant
    SELECT 'grant'                  UNION ALL  -- slug
    SELECT 'Grant/Central Eastside' UNION ALL  -- display name
    SELECT 'Grant Central Eastside' UNION ALL  -- alias variant
    SELECT 'nelson'                 UNION ALL  -- slug
    SELECT 'Clackamas/Nelson'       UNION ALL  -- display name
    SELECT 'Nelson'                 UNION ALL  -- alias (conflicts with slug, one survives)
    SELECT 'Corvallis'              UNION ALL  -- alias for corvallis team
    SELECT 'Crescent Valley'        UNION ALL  -- alias for corvallis team
    SELECT 'West Salem'             UNION ALL  -- alias for west_salem team
    SELECT 'borah'                  UNION ALL  -- out-of-state slug
    SELECT 'Borah HS (ID)'                     -- out-of-state display name
) raw
JOIN team_aliases ta ON ta.alias_normalized = LOWER(TRIM(raw.val))
JOIN teams t ON t.id = ta.team_id
ORDER BY raw.val;
```

Expected output: Exactly 14 rows. Each `looked_up` value maps to the correct `resolved_slug`:

| looked_up | resolved_slug |
|---|---|
| borah | borah |
| borah hs (id) | borah |
| corvallis | corvallis |
| crescent valley | corvallis |
| clackamas/nelson | nelson |
| grant | grant |
| grant central eastside | grant |
| grant/central eastside | grant |
| mountain view | mt_view |
| mt. view | mt_view |
| mt_view | mt_view |
| nelson | nelson |
| west salem | west_salem |
| west salem/mcnary | west_salem |

**GO:** All 14 rows returned. Every `resolved_slug` matches the table above.
**NO-GO:** Any row missing (lookup returned no match) or maps to the wrong slug.
If this fails: For each missing lookup, run `SELECT * FROM team_aliases WHERE alias_normalized = LOWER(TRIM('<value>'));` to confirm the alias exists. If missing, add it to `team_aliases` and re-run the spot-test.

---

## C8.5. Verify all `games_v1` opponents resolve via `team_aliases`

What to do: Surface any opponent string in the old schedule that will be silently dropped by D1's alias JOIN. Run after C3, before closing Section C.

```sql
SELECT DISTINCT g.opponent   AS still_unresolved,
                COUNT(*)     AS occurrences
FROM   games_v1 g
LEFT JOIN team_aliases ta
       ON ta.alias_normalized = LOWER(TRIM(g.opponent))
WHERE  ta.id IS NULL
GROUP  BY g.opponent
ORDER  BY occurrences DESC;
```

Expected output: **0 rows.**

**GO:** 0 rows. Every opponent string in `games_v1` resolves to a known alias. Proceed to C9.
**NO-GO:** Any rows returned.
If rows are returned: for each unresolved opponent, add the missing alias to `team_aliases` (and a placeholder `teams` row if that opponent has none) using the C3 template, then re-run this query until it returns 0 rows. Do not proceed to Section D with unresolved opponents — D1's JOIN will silently drop those games.

---

## C9. Section C sign-off gate

What to do: Confirm all reference data is present and correct before Section D backfills game data.

```sql
SELECT 'venues'       AS tbl, COUNT(*) AS rows FROM venues
UNION ALL SELECT 'teams',         COUNT(*) FROM teams
UNION ALL SELECT 'team_aliases',  COUNT(*) FROM team_aliases
UNION ALL SELECT 'team_seasons',  COUNT(*) FROM team_seasons
UNION ALL SELECT 'coaches',       COUNT(*) FROM coaches
UNION ALL SELECT 'team_coaches',  COUNT(*) FROM team_coaches;
```

Expected output: venues ≥ 41, teams ≥ 42 (41 Oregon + at least 1 out-of-state), team_aliases ≥ 100, team_seasons = 41, coaches = 4, team_coaches = 4.

| # | Item | Status |
|---|---|---|
| 1 | 41 venues seeded (C1) | ☐ |
| 2 | 41 Oregon teams seeded (C2) | ☐ |
| 3 | All out-of-state teams from A7 seeded with aliases (C3) | ☐ |
| 4 | All 41 Oregon teams have non-NULL `home_venue_id` (C4) | ☐ |
| 5 | Every Oregon team has ≥ 2 aliases; total ≥ 100 (C5) | ☐ |
| 6 | 41 team_seasons rows for 2026, correct conference per team (C6) | ☐ |
| 7 | 4 coaches and 4 team_coaches rows for mt_view (C7) | ☐ |
| 8 | All 14 alias spot-tests resolve to correct slugs (C8) | ☐ |
| 9 | 0 unresolved opponents in games_v1 (C8.5) | ☐ |

**GO:** All 9 boxes checked. Proceed to Section D.
**NO-GO:** Any box unchecked.
If this fails: Return to the failing step, diagnose using that step's verification query, fix, and re-run before proceeding.

*Sign off here (name + timestamp): ___________________________*

---

*End of Section C. Section D backfills game and rankings data from the `*_v1` legacy tables into the new schema.*
