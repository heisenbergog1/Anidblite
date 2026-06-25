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
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
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

  const p = event.queryStringParameters || {};
  const action = p.action;

  try {

    // ── Search ───────────────────────────────────────────
    if (action === 'search') {
      if (!p.q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing q' }) };

      const res = await httpsGet(`https://anidb.app/search/suggestions?q=${encodeURIComponent(p.q)}`);

      // Raw HTML has anchor tags like:
      // <a href="/anime/steins-gate-1337">...</a>
      // Extract all href="/anime/SLUG-ID" patterns
      const results = [];
      const seen = {};

      // Match href="/anime/anything-DIGITS"
      const hrefRe = /href="\/anime\/([a-z0-9-]+)-(\d+)"/gi;
      let m;
      while ((m = hrefRe.exec(res.body)) !== null) {
        const id = parseInt(m[2]);
        if (seen[id]) continue;
        seen[id] = true;

        // Get the text content after this href up to </a>
        const afterHref = res.body.slice(m.index + m[0].length);
        const textMatch = afterHref.match(/>([\s\S]*?)<\/a>/);
        let title = '';
        let type = '';
        let year = '';

        if (textMatch) {
          // Strip HTML tags
          const raw = textMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          // Format: "Title TitleTV · 2011" or "Title TitleMovie · 2021"
          const typeYearMatch = raw.match(/(TV|Movie|OVA|ONA|Special|Music)\s*[·•]\s*(\d{4})/);
          if (typeYearMatch) {
            type = typeYearMatch[1];
            year = typeYearMatch[2];
            // Title is everything before the type, appears twice — take first half
            const beforeType = raw.slice(0, raw.indexOf(typeYearMatch[0])).trim();
            title = beforeType.slice(0, Math.ceil(beforeType.length / 2)).trim() || beforeType;
          } else {
            // No type/year found — use full text deduplicated
            title = raw.slice(0, Math.ceil(raw.length / 2)).trim() || raw;
          }
        }

        if (!title) {
          // Fallback: derive title from slug
          title = m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }

        results.push({
          id,
          slug: m[1],
          title: title.trim(),
          type,
          year,
          image: `https://cdn.anidb.app/posters/${id}.jpg`,
        });
      }

      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    // ── Episodes ─────────────────────────────────────────
    if (action === 'episodes') {
      if (!p.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
      const res = await httpsGet(`https://anidb.app/api/frontend/anime/${p.id}/episodes`);
      return { statusCode: 200, headers, body: res.body };
    }

    // ── Languages ─────────────────────────────────────────
    if (action === 'languages') {
      if (!p.epId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing epId' }) };
      const res = await httpsGet(`https://anidb.app/api/frontend/episode/${p.epId}/languages`);
      return { statusCode: 200, headers, body: res.body };
    }

    // ── Stream (extract m3u8 from embed) ─────────────────
    if (action === 'stream') {
      if (!p.embedUrl) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing embedUrl' }) };
      const res = await httpsGet(p.embedUrl);
      const match = res.body.match(/file:\s*['"]([^'"]*hls\.anidb\.app[^'"]*master\.m3u8)['"]/);
      if (!match) {
        // Debug: return a snippet to help diagnose
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Stream URL not found', snippet: res.body.slice(0, 300) }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ url: match[1] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};