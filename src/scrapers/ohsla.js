const axios   = require('axios');
const cheerio = require('cheerio');

const SEASON   = parseInt(process.env.SEASON || '2026');
const DELAY_MS = 400;

// ─── School → teamId mapping ────────────────────────────────────────────────
const SCHOOLS = [
  { id:   7, teamId: 'aloha_southridge' },
  { id:  20, teamId: 'beaverton'        },
  { id: 131, teamId: 'bend_caldera'     },
  { id: 479, teamId: 'burns'            },
  { id: 288, teamId: 'canby'            },
  { id: 243, teamId: 'central_catholic' },
  { id:  10, teamId: 'century'          },
  { id: 201, teamId: 'corvallis'        },
  { id: 360, teamId: 'forest_grove'     },
  { id:  14, teamId: 'glencoe'          },
  { id:   1, teamId: 'grant_central'    },
  { id: 178, teamId: 'hillsboro'        },
  { id:  13, teamId: 'hood_river'       },
  { id:   9, teamId: 'ida_b_wells'      },
  { id: 199, teamId: 'jesuit'           },
  { id:   4, teamId: 'lake_oswego'      },
  { id:  19, teamId: 'lakeridge'        },
  { id:  79, teamId: 'liberty'          },
  { id:  11, teamId: 'lincoln'          },
  { id: 183, teamId: 'marist'           },
  { id: 476, teamId: 'mountainside'     },
  { id: 289, teamId: 'mt_view'          },
  { id: 182, teamId: 'clackamas_nelson' },
  { id: 204, teamId: 'newberg'          },
  { id: 177, teamId: 'oes'              },
  { id:  21, teamId: 'oregon_city'      },
  { id:   3, teamId: 'roseburg'         },
  { id:  18, teamId: 'sheldon'          },
  { id:  57, teamId: 'sherwood'         },
  { id: 200, teamId: 'south_eugene'     },
  { id:  17, teamId: 'sprague'          },
  { id: 163, teamId: 'summit'           },
  { id:   2, teamId: 'sunset'           },
  { id:  56, teamId: 'thurston'         },
  { id:  12, teamId: 'tigard'           },
  { id: 167, teamId: 'tualatin'         },
  { id: 330, teamId: 'west_albany'      },
  { id:   8, teamId: 'west_linn'        },
  { id:  25, teamId: 'west_salem'       },
  { id:  23, teamId: 'westview'         },
  { id:  80, teamId: 'wilsonville'      },
];

const MONTH_MAP = {
  january: 1, february: 2, march:     3, april:   4,
  may:     5, june:     6, july:      7, august:  8,
  september: 9, october: 10, november: 11, december: 12,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// "21st" → 21, "3rd" → 3
function parseDay(text) {
  const n = parseInt(text.replace(/\D/g, ''), 10);
  return isNaN(n) ? null : n;
}

// "W 11-7" → { result:'W', teamScore:11, oppScore:7, isOT:false }
// "L 4-5 OT" → { result:'L', teamScore:4, oppScore:5, isOT:true }
function parseResult(text) {
  const empty = { result: null, teamScore: null, oppScore: null, isOT: false };
  if (!text || !text.trim()) return empty;

  const t    = text.trim();
  const isOT = /OT/i.test(t);
  const m    = t.match(/^([WLwl])\s+(\d+)-(\d+)/);
  if (!m) return { ...empty, isOT };

  return {
    result:    m[1].toUpperCase(),
    teamScore: parseInt(m[2], 10),
    oppScore:  parseInt(m[3], 10),
    isOT,
  };
}

// Fetch and parse one team's OHSLA schedule page
async function scrapeTeam(schoolId, teamId) {
  const url = `https://ohsla.net/BHS/school.asp?id=${schoolId}`;

  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)' },
    timeout: 15000,
  });

  const $      = cheerio.load(html);
  const games  = [];
  let curMonth = null;

  $('tr').each((_, row) => {
    const cells     = $(row).find('td');
    const rowText   = $(row).text().replace(/\s+/g, ' ').trim().toLowerCase();

    // ── Month header ──────────────────────────────────────────────────────
    // OHSLA renders month names as a single-cell row spanning all columns
    const monthNum = MONTH_MAP[rowText];
    if (monthNum) {
      curMonth = monthNum;
      return; // continue
    }

    // ── Game row ──────────────────────────────────────────────────────────
    // Requires 7+ cells and an established month
    if (cells.length < 7 || curMonth === null) return;

    const dayNum = parseDay($(cells[2]).text().trim());
    if (!dayNum) return;

    const month = String(curMonth).padStart(2, '0');
    const day   = String(dayNum).padStart(2, '0');
    const date  = `${SEASON}-${month}-${day}`;

    const timeRaw   = $(cells[3]).text().trim();
    const time      = timeRaw || null;

    const oppRaw    = $(cells[4]).text().replace(/\s+/g, ' ').trim();
    if (!oppRaw) return; // blank row — skip

    const isHome       = !oppRaw.startsWith('@');
    const opponent     = oppRaw.replace(/^@\s*/, '').trim();

    const confText     = $(cells[5]).text().trim().toLowerCase();
    const isConference = confText === 'yes';

    const resultText   = cells.length > 6 ? $(cells[6]).text().trim() : '';
    const { result, teamScore, oppScore, isOT } = parseResult(resultText);

    games.push({
      teamId,
      date,
      time,
      opponent,
      isHome,
      isConference,
      result:    result    ?? null,
      teamScore: teamScore ?? null,
      oppScore:  oppScore  ?? null,
      isOT:      isOT      ?? false,
      season:    SEASON,
      scrapedAt: new Date(),
    });
  });

  return games;
}

// Scrape all 41 teams with a polite delay between requests
async function scrapeOHSLA() {
  console.log(`[OHSLA] Scraping ${SCHOOLS.length} team schedules (${DELAY_MS}ms delay)...`);
  const allGames = [];

  for (const { id, teamId } of SCHOOLS) {
    try {
      const games = await scrapeTeam(id, teamId);
      allGames.push(...games);
      console.log(`[OHSLA]   ${teamId.padEnd(20)} → ${games.length} games`);
    } catch (err) {
      console.error(`[OHSLA]   ${teamId} (id=${id}) failed: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`[OHSLA] Total: ${allGames.length} games across ${SCHOOLS.length} teams`);
  return allGames;
}

module.exports = { scrapeOHSLA };
