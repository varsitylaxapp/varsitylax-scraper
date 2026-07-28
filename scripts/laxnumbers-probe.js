#!/usr/bin/env node
// Railway ONE-OFF (no schedule). READ-ONLY — touches no database.
//
// Purpose: this machine is Cloudflare-403'd on laxnumbers.com, so these probes
// have to run from Railway (whose egress the site already accepts — the 2-hour
// prod cron scrapes successfully from there).
//
// Two questions:
//   1. Does /ratings/service?y=&v= return usable JSON for each state id?
//      OR 3443 is the known-good control.
//   2. Is WA per-class data addressable? Decision 2c=3 treats the four WA class
//      pages as a SEEDING input for team classification. If they are not
//      addressable, classification falls back to the WHSBLA answer or a manual
//      seed — flag it, do not guess.
const axios = require('axios');

const UA = 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)';
const SEASON = parseInt(process.env.SEASON || '2026');

const STATE_IDS = [
  { code: 'OR', v: 3443, note: 'known-good control' },
  { code: 'WA', v: 3580 },
  { code: 'AZ', v: 3013 },
  { code: 'ID', v: 3146 },
  { code: 'MT', v: 3300 },
  { code: 'NV', v: 3341 },
];

async function probeService(v) {
  const qs = `y=${SEASON}&v=${v}`;
  const url = `https://www.laxnumbers.com/ratings/service?${qs}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': `https://www.laxnumbers.com/ratings.php?${qs}` },
      timeout: 20000, validateStatus: () => true,
    });
    const ct = res.headers['content-type'] || '';
    const isJson = ct.includes('json') || Array.isArray(res.data);
    const arr = Array.isArray(res.data) ? res.data : null;
    return {
      status: res.status, contentType: ct.split(';')[0], isJson,
      count: arr ? arr.length : null,
      keys: arr && arr[0] ? Object.keys(arr[0]) : null,
      sample: arr && arr[0] ? { name: arr[0].name, ranking: arr[0].ranking, wins: arr[0].wins, losses: arr[0].losses, rating: arr[0].rating } : null,
      bodyHead: !arr ? String(res.data).slice(0, 120) : null,
    };
  } catch (e) {
    return { error: e.code || e.message };
  }
}

// Pull the rankings index and find every link whose label mentions a class for
// the given state prefix (e.g. "WA Class 4A"). The index is server-rendered
// HTML; a regex over anchors is sufficient and avoids adding a parser dep.
async function findClassPages(statePrefix) {
  const url = 'https://www.laxnumbers.com/current-rankings/boys';
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: () => true,
    });
    if (res.status !== 200) return { status: res.status, links: [], bodyHead: String(res.data).slice(0, 160) };
    const html = String(res.data);
    const re = /<a[^>]+href="([^"]*ratings\.php\?[^"]*v=(\d+)[^"]*)"[^>]*>\s*([^<]{1,80}?)\s*<\/a>/gi;
    const all = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      all.push({ v: parseInt(m[2]), label: m[3].replace(/\s+/g, ' ').trim() });
    }
    const rx = new RegExp(`^${statePrefix}\\b`, 'i');
    return {
      status: 200,
      totalAnchors: all.length,
      stateLinks: all.filter(x => rx.test(x.label)),
      anyClassLinks: all.filter(x => /class/i.test(x.label)).slice(0, 12),
    };
  } catch (e) {
    return { error: e.code || e.message, links: [] };
  }
}

(async () => {
  console.log('\n=== laxnumbers-probe (read-only, no DB) ===');
  console.log(`season y=${SEASON}\n`);

  console.log('--- 1. /ratings/service per state id ---');
  for (const s of STATE_IDS) {
    const r = await probeService(s.v);
    const tag = `${s.code} v=${s.v}${s.note ? ' (' + s.note + ')' : ''}`;
    if (r.error) { console.log(`  ${tag.padEnd(34)} ERROR ${r.error}`); continue; }
    console.log(`  ${tag.padEnd(34)} HTTP ${r.status} ${r.contentType} json=${r.isJson} teams=${r.count}`);
    if (r.keys) console.log(`      keys: ${r.keys.join(',')}`);
    if (r.sample) console.log(`      first: ${JSON.stringify(r.sample)}`);
    if (r.bodyHead) console.log(`      body: ${r.bodyHead}`);
    await new Promise(r2 => setTimeout(r2, 500));
  }

  console.log('\n--- 2. WA per-class pages addressable? (decision 2c=3 dependency) ---');
  const wa = await findClassPages('WA');
  if (wa.error) {
    console.log(`  ERROR ${wa.error}`);
  } else if (wa.status !== 200) {
    console.log(`  index HTTP ${wa.status} — ${wa.bodyHead}`);
  } else {
    console.log(`  index OK, ${wa.totalAnchors} ranking anchors found`);
    console.log(`  labels starting "WA": ${wa.stateLinks.length}`);
    for (const l of wa.stateLinks) console.log(`      v=${String(l.v).padEnd(6)} ${l.label}`);
    console.log(`  sample of any "Class" labels site-wide (shape reference):`);
    for (const l of wa.anyClassLinks) console.log(`      v=${String(l.v).padEnd(6)} ${l.label}`);
    const waClasses = wa.stateLinks.filter(l => /class/i.test(l.label));
    console.log(`\n  VERDICT: WA class pages ${waClasses.length >= 4 ? 'ADDRESSABLE (' + waClasses.length + ' found)' : 'NOT CONFIRMED (' + waClasses.length + ' found — expected 4: 4A, 3A, 2A/A, Private)'}`);
    if (waClasses.length < 4) {
      console.log('  -> classification source of truth must fall back to the WHSBLA');
      console.log('     answer or a manual seed. DO NOT GUESS a team\'s division.');
    }
  }
  console.log('\n=== probe complete ===\n');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
