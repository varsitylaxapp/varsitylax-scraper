const axios = require('axios');

axios.get('https://www.laxnumbers.com/ratings/service?y=2026&v=3443', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; VarsityLaxScraper/1.0)',
    'Referer':    'https://www.laxnumbers.com/ratings.php?y=2026&v=3443',
  },
  timeout: 15000,
}).then(r => {
  console.log('Status:', r.status);
  console.log('Content-Type:', r.headers['content-type']);
  const data = r.data;
  console.log('Type:', typeof data, Array.isArray(data) ? '(array)' : '');
  if (typeof data === 'object') {
    const keys = Array.isArray(data) ? 'array' : Object.keys(data).slice(0, 10);
    console.log('Keys/length:', Array.isArray(data) ? data.length : keys);
    const sample = Array.isArray(data) ? data[0] : data[Object.keys(data)[0]];
    console.log('First item:', JSON.stringify(sample, null, 2));
  } else {
    console.log('Raw (first 500 chars):', String(data).slice(0, 500));
  }
}).catch(e => console.error('Error:', e.message));
