# varsitylax-scraper

Scrapes OHSLA (ohsla.net) for game scores, standings, and team data, then computes power ratings.

## Setup

```bash
cd varsitylax-scraper
npm install
cp .env.example .env
# edit .env with your DreamHost DB password
```

Apply the schema to your MySQL database:

```bash
mysql -h mysql.varsitylaxapp.com -u varsitylax -p varsitylax < db/schema.sql
```

## Usage

```bash
# Scrape + compute ratings (default)
npm start

# Scrape only
npm run scrape

# Ratings only (uses existing game data in DB)
npm run ratings
```

## How ratings work

1. All completed non-scrimmage games are pulled from the DB.
2. Per-team **AGD** (Average Goal Differential) is computed, capped at 10 goals per game.
3. **SCHED** is computed iteratively over 15 passes: each team's schedule strength = average of all opponents' current ratings.
4. Final `rating = AGD + SCHED`. Teams are ranked descending.
5. Results are upserted into the `ratings` table with `week_ending = today`.

## File layout

```
src/
  index.js    — entry point (scrape → rate)
  scraper.js  — cheerio-based HTML scraper for ohsla.net
  db.js       — mysql2 connection pool + upsert helpers
  ratings.js  — computeRatings(season)
db/
  schema.sql  — CREATE TABLE statements
```

## Notes on player stats

OHSLA player stats require an authenticated login to enter/view. The `player_stats` table is in the schema for future use but is not currently populated by the scraper.
# varsitylax-scraper
# varsitylax-scraper
