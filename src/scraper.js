require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.ohsla.net';
const SEASON = parseInt(process.env.SEASON || new Date().getFullYear());

// Polite delay between requests (ms)
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'varsitylax-scraper/1.0 (educational/non-commercial)' },
    timeout: 15000,
  });
  return data;
}

// ── Parse a month abbreviation + day string into a YYYY-MM-DD date ────────────
// The schedule page shows day headers like "Monday, Mar 16th"
// The team page shows rows like "Mo 16th"
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDate(text) {
  if (!text) return null;
  const m = text.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d+)/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, '0');
  return `${SEASON}-${month}-${day}`;
}

// ── Extract ohsla school id from a school.asp link ────────────────────────────
function schoolId(href) {
  if (!href) return null;
  const m = href.match(/[?&]id=(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

// ── Scrape all teams from School.asp ─────────────────────────────────────────
async function scrapeTeams() {
  console.log('Scraping team list…');
  const html = await fetchPage(`${BASE}/BHS/School.asp`);
  const $ = cheerio.load(html);
  const teams = [];

  $('a[href*="school.asp?id="], a[href*="School.asp?id="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const id   = schoolId(href);
    if (!id) return;
    const name = $(el).text().trim();
    if (!name) return;
    // Avoid duplicates
    if (!teams.find((t) => t.id === id)) {
      teams.push({ id, season: SEASON, name, conference: null });
    }
  });

  console.log(`  Found ${teams.length} teams`);
  return teams;
}

// ── Scrape main schedule / scores page ───────────────────────────────────────
// Returns array of game objects.
// The page lists games chronologically; date headers separate each day's games.
// Completed game format:  "Away Team SCORE @ Home Team SCORE"
// Upcoming game format:   "Away Team TIME @ Home Team"  (no score)
async function scrapeSchedule() {
  console.log('Scraping schedule / scores…');
  const html = await fetchPage(`${BASE}/BHS/Schedule.asp?Grp=BHS`);
  const $ = cheerio.load(html);
  const games = [];

  let currentDate = null;

  // Walk every element in document order looking for date headers and game rows.
  // OHSLA uses <b> or <strong> or a header-like element for date labels,
  // and table rows or divs for individual games.
  $('body').find('*').each((_, el) => {
    const tag  = el.tagName ? el.tagName.toLowerCase() : '';
    const text = $(el).text().trim();

    // Date headers look like "Monday, Mar 16th" or "Thu Apr 17th"
    if (['b', 'strong', 'h3', 'h4', 'td'].includes(tag)) {
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text) && /\d+/.test(text)) {
        const d = parseDate(text);
        if (d) {
          currentDate = d;
          return; // continue
        }
      }
    }

    // Game rows: must contain an "@" and at least one school.asp link
    if (!currentDate) return;
    if (tag !== 'tr' && tag !== 'div' && tag !== 'p' && tag !== 'td') return;

    const links = $(el).find('a[href*="school.asp"]');
    if (links.length < 2) return;
    if (!text.includes('@')) return;

    // Skip if this element is a header we already processed
    if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text) && !/vs|@/.test(text)) return;

    // Determine if conference game (OHSLA marks these with a red border tr class
    // or a class like "confgame")
    const rowClass = ($(el).attr('class') || '').toLowerCase();
    const isConference = rowClass.includes('conf') || rowClass.includes('red');

    // Determine if scrimmage — OHSLA sometimes labels these in the game text
    const isScrimmage = /scrimmage/i.test(text);

    // Split on "@" to find away side and home side
    const atIndex = text.indexOf('@');
    const awaySide = text.substring(0, atIndex).trim();
    const homeSide = text.substring(atIndex + 1).trim();

    // Extract team IDs from links
    const linkEls = links.toArray();
    if (linkEls.length < 2) return;

    // First link = away team, second link = home team
    // (This matches the "Away @ Home" rendering order on the page)
    const awayId = schoolId($(linkEls[0]).attr('href'));
    const homeId = schoolId($(linkEls[1]).attr('href'));
    if (!awayId || !homeId || awayId === homeId) return;

    // Extract scores: integers that appear immediately after the team link text
    // "Central Catholic 10 @ Skyview 6"  → away=10, home=6
    const awayScoreMatch = awaySide.match(/(\d+)\s*$/);
    const homeScoreMatch = homeSide.match(/^.*?(\d+)/);

    // Distinguish a score from a time (times have ":" like "7:00pm" or "7:00")
    const awayIsTime = /\d+:\d+/.test(awaySide);
    const homeIsTime = /\d+:\d+/.test(homeSide.split(/\s+/)[0]);

    const awayScore = (!awayIsTime && awayScoreMatch) ? parseInt(awayScoreMatch[1]) : null;
    const homeScore = (!homeIsTime && homeScoreMatch && !awayIsTime) ? parseInt(homeScoreMatch[1]) : null;

    // Location: sometimes a third link or text follows the home score
    const locationEl = $(el).find('a[href*="field.asp"]').first();
    const location = locationEl.length ? locationEl.text().trim() : null;

    games.push({
      season:       SEASON,
      game_date:    currentDate,
      away_team_id: awayId,
      home_team_id: homeId,
      away_score:   awayScore,
      home_score:   homeScore,
      is_conference: isConference,
      is_scrimmage:  isScrimmage,
      location,
    });
  });

  // Deduplicate (same date + same pair might appear in multiple container elements)
  const seen = new Set();
  const deduped = games.filter((g) => {
    const key = `${g.game_date}|${g.home_team_id}|${g.away_team_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Found ${deduped.length} games`);
  return deduped;
}

// ── Scrape individual team page to enrich conference flag on games ─────────────
// Returns array of { game_date, opponent_id, is_conference, is_scrimmage, result, home_score, away_score, is_home }
async function scrapeTeamSchedule(teamId) {
  const html = await fetchPage(`${BASE}/BHS/School.asp?id=${teamId}`);
  const $    = cheerio.load(html);
  const rows = [];

  // Find the schedule table — it has columns: Date | Time | Opponent | Div Game | W/L | Location
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 5) return;

    const dateText  = $(cells[0]).text().trim();
    const oppCell   = $(cells[2]);
    const divGame   = $(cells[3]).text().trim().toLowerCase();
    const resultText = $(cells[4]).text().trim(); // "W 10-6" or "L 2-18" or ""

    const date = parseDate(dateText);
    if (!date) return;

    const oppLink = oppCell.find('a[href*="school.asp"]').first();
    const oppId   = schoolId(oppLink.attr('href'));
    if (!oppId) return;

    // "@" prefix on opponent text means this team is the AWAY team (opponent is home)
    const oppText   = oppCell.text().trim();
    const isHome    = !oppText.startsWith('@');
    const isConference = divGame === 'yes';
    const isScrimmage  = /scrimmage/i.test(oppText + resultText);

    // Parse "W 10-6" or "L 2-18"
    let teamScore = null, oppScore = null;
    const scoreMatch = resultText.match(/[WL]\s*(\d+)-(\d+)/i);
    if (scoreMatch) {
      teamScore = parseInt(scoreMatch[1]);
      oppScore  = parseInt(scoreMatch[2]);
    }

    rows.push({
      game_date:     date,
      opponent_id:   oppId,
      is_conference: isConference,
      is_scrimmage:  isScrimmage,
      is_home:       isHome,
      team_score:    teamScore,
      opp_score:     oppScore,
    });
  });

  return rows;
}

// ── Scrape standings page ─────────────────────────────────────────────────────
// Returns array of { team_id, name, conference, overall_wins, overall_losses }
// Note: the standings page only shows overall W-L; conf W-L is inferred from games.
async function scrapeStandings() {
  console.log('Scraping standings…');
  const html = await fetchPage(`${BASE}/BHS/Standings.asp`);
  const $    = cheerio.load(html);
  const standings = [];

  let currentConference = null;

  // Conference headers are typically <b>, <h3>, or a highlighted table row
  $('body').find('*').each((_, el) => {
    const tag  = el.tagName ? el.tagName.toLowerCase() : '';
    const text = $(el).text().trim();

    // Detect conference name header (e.g. "Pacific Conference", "Metro Conference")
    // These appear before each group of team rows
    if (['b', 'strong', 'h3', 'h4'].includes(tag) && /conference|division/i.test(text)) {
      currentConference = text.replace(/conference|division/gi, '').trim();
      return;
    }

    if (tag !== 'tr') return;

    const cells = $(el).find('td');
    if (cells.length < 3) return;

    const teamLink = $(cells[0]).find('a[href*="school.asp"]').first();
    const teamId   = schoolId(teamLink.attr('href'));
    if (!teamId) return;

    const name = teamLink.text().trim();
    if (!name) return;

    // Columns: Team | W | L | (overall or conf — varies by page)
    const winsText   = $(cells[1]).text().trim();
    const lossesText = $(cells[2]).text().trim();
    const overall_wins   = parseInt(winsText)   || 0;
    const overall_losses = parseInt(lossesText) || 0;

    standings.push({
      team_id:       teamId,
      season:        SEASON,
      conference:    currentConference,
      conf_wins:     0,   // will be computed from games
      conf_losses:   0,
      overall_wins,
      overall_losses,
    });
  });

  console.log(`  Found ${standings.length} standing entries`);
  return standings;
}

// ── Full scrape: teams → schedule → standings ─────────────────────────────────
// Returns { teams, games, standings }
async function scrapeAll() {
  const teams = await scrapeTeams();
  await sleep(DELAY_MS);

  const games = await scrapeSchedule();
  await sleep(DELAY_MS);

  const standings = await scrapeStandings();
  await sleep(DELAY_MS);

  // Enrich conference / scrimmage flags on games by checking individual team pages.
  // Only fetch team pages for teams we already know about (avoids out-of-state noise).
  const knownIds = new Set(teams.map((t) => t.id));
  const teamsToFetch = [...knownIds].slice(0, 60); // cap to avoid hammering server

  console.log(`Enriching ${teamsToFetch.length} team schedules for conference flags…`);
  for (const tid of teamsToFetch) {
    try {
      const rows = await scrapeTeamSchedule(tid);
      for (const row of rows) {
        // Find the matching game and update its flags
        const game = games.find((g) => {
          const dateMatch = g.game_date === row.game_date;
          if (!dateMatch) return false;
          if (row.is_home) {
            return g.home_team_id === tid && g.away_team_id === row.opponent_id;
          } else {
            return g.away_team_id === tid && g.home_team_id === row.opponent_id;
          }
        });
        if (game) {
          game.is_conference = game.is_conference || row.is_conference;
          game.is_scrimmage  = game.is_scrimmage  || row.is_scrimmage;
          // Fill in scores from team page if missing from main schedule parse
          if (game.home_score === null && row.team_score !== null) {
            if (row.is_home) {
              game.home_score = row.team_score;
              game.away_score = row.opp_score;
            } else {
              game.away_score = row.team_score;
              game.home_score = row.opp_score;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`  Warning: could not fetch team page for id=${tid}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  return { teams, games, standings };
}

module.exports = { scrapeAll, scrapeTeams, scrapeSchedule, scrapeStandings, scrapeTeamSchedule };
