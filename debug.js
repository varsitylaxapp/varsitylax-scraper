const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
  const { data } = await axios.get('https://www.ohsla.net/BHS/Schedule.asp?Grp=BHS', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);

  // Find date header HTML — look for something with "Mar" or "Apr" in it
  console.log('--- Searching for date headers ---');
  $('*').each(function() {
    const text = $(this).text().trim();
    if (/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(text) && /\b(Mar|Apr|May)\b/.test(text) && text.length < 50) {
      const tag = this.tagName;
      const cls = $(this).attr('class') || '';
      const id = $(this).attr('id') || '';
      console.log(`TAG: ${tag} | CLASS: ${cls} | ID: ${id} | TEXT: ${text}`);
    }
  });

  // Also show the HTML around "@" to see full game block
  console.log('\n--- Full game block HTML (500 chars) ---');
  const idx = data.indexOf('bgcolor="#ccff99"');
  console.log(data.substring(Math.max(0, idx - 500), idx + 800));
})();
