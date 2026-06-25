// Netlify Function — proxies anidb.app requests to bypass CORS
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://anidb.app/',
        'Accept': 'text/html,application/json,*/*',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const action = event.queryStringParameters?.action;

  try {
    // ── Search ──────────────────────────────────────────
    if (action === 'search') {
      const q = event.queryStringParameters?.q;
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing q' }) };

      const res = await httpsGet(`https://anidb.app/search/suggestions?q=${encodeURIComponent(q)}`);

      // Parse HTML: extract title, type, year, id from anchor tags
      // Format: <a href="/anime/slug-ID">Title...</a>
      const results = [];
      const re = /href="\/anime\/([^"]+)-(\d+)"[^>]*>([^<]+)/g;
      let m;
      while ((m = re.exec(res.body)) !== null) {
        const slug = m[1];
        const id = parseInt(m[2]);
        const rawText = m[3].trim();
        // Text contains title twice then type · year — grab first occurrence
        // e.g. "Steins;Gate Steins;GateTV · 2011"
        const halfLen = Math.floor(rawText.length / 2);
        // Try to split on type pattern
        const typeMatch = rawText.match(/^(.+?)(TV|Movie|OVA|ONA|Special|Music)\s*·\s*(\d{4})/);
        let title, type, year;
        if (typeMatch) {
          // title appears twice before type
          const rawTitle = typeMatch[1].trim();
          title = rawTitle.slice(0, Math.ceil(rawTitle.length / 2)).trim() || rawTitle;
          type = typeMatch[2];
          year = typeMatch[3];
        } else {
          title = rawText.slice(0, halfLen).trim() || rawText;
          type = '';
          year = '';
        }
        if (id && title) {
          results.push({ id, slug, title, type, year,
            image: `https://cdn.anidb.app/posters/${id}.jpg` });
        }
      }

      // Deduplicate by id
      const seen = {};
      const unique = results.filter(r => { if (seen[r.id]) return false; seen[r.id] = true; return true; });

      return { statusCode: 200, headers, body: JSON.stringify(unique) };
    }

    // ── Episodes ─────────────────────────────────────────
    if (action === 'episodes') {
      const id = event.queryStringParameters?.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

      const res = await httpsGet(`https://anidb.app/api/frontend/anime/${id}/episodes`);
      return { statusCode: 200, headers, body: res.body };
    }

    // ── Languages for episode ────────────────────────────
    if (action === 'languages') {
      const epId = event.queryStringParameters?.epId;
      if (!epId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing epId' }) };

      const res = await httpsGet(`https://anidb.app/api/frontend/episode/${epId}/languages`);
      return { statusCode: 200, headers, body: res.body };
    }

    // ── Get m3u8 from embed URL ───────────────────────────
    if (action === 'stream') {
      const embedUrl = event.queryStringParameters?.embedUrl;
      if (!embedUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing embedUrl' }) };

      const res = await httpsGet(embedUrl);
      // Extract m3u8 URL from embed HTML
      const match = res.body.match(/file:\s*'(https:\/\/hls\.anidb\.app\/[^']+master\.m3u8)'/);
      if (!match) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Could not find stream URL' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ url: match[1] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
