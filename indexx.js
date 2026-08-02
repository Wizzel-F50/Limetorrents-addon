// indexx.js – Stremio Addon for Watchnest
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");


// ========== MANIFEST ==========
const manifest = {
    id: 'org.stremio.watchnest',
    version: '1.0.0',
    name: 'Watchnest',
    description: 'Scrape movie and TV stream links from watchnest.org',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [] // No catalog – only streams
};

// ========== BUILDER ==========
const builder = new addonBuilder(manifest);

// ========== STREAM HANDLER ==========
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        // Watchnest URL pattern – assumes /watch/{imdb_id}
        const url = `https://www.watchnest.org/watch/${id}`;
        console.log(`Fetching: ${url}`);

        // Fetch page with browser-like headers
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://www.watchnest.org/'
            }
        });

        const $ = cheerio.load(data);
        const streams = [];

        // 1. Search for <source> tags inside <video>
        $('video source').each((i, el) => {
            const src = $(el).attr('src');
            if (src) {
                streams.push({
                    title: `Watchnest (${i + 1})`,
                    url: src,
                    quality: $(el).attr('quality') || 'auto'
                });
            }
        });

        // 2. Search for <iframe> sources (often embedded players)
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.startsWith('http')) {
                streams.push({
                    title: `Embedded Player ${i + 1}`,
                    url: src,
                    externalUrl: true // Stremio can open external players
                });
            }
        });

        // 3. Direct links to media files (mp4, m3u8, etc.)
        $('a[href*=".mp4"], a[href*=".m3u8"], a[href*=".mkv"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.startsWith('http')) {
                streams.push({
                    title: `Direct Link ${i + 1}`,
                    url: href
                });
            }
        });

        // 4. Fallback: extract any video URL from the page (e.g., in data-* attributes)
        //    This is a generic catch-all for common patterns.
        const pageText = $.html();
        const videoUrls = pageText.match(/(https?:\/\/[^\s"']+\.(?:mp4|m3u8|mkv|webm))/gi);
        if (videoUrls) {
            videoUrls.forEach((url, idx) => {
                // Avoid duplicates
                if (!streams.some(s => s.url === url)) {
                    streams.push({
                        title: `Discovered Video ${idx + 1}`,
                        url: url
                    });
                }
            });
        }

        if (streams.length === 0) {
            console.warn(`No streams found for ${id}`);
            return { streams: [] };
        }

        // Remove duplicates (by URL)
        const unique = [];
        const seen = new Set();
        streams.forEach(s => {
            if (!seen.has(s.url)) {
                seen.add(s.url);
                unique.push(s);
            }
        });

        return { streams: unique };
    } catch (error) {
        console.error(`Error fetching streams for ${id}:`, error.message);
        // Return empty streams to avoid breaking the addon
        return { streams: [] };
    }
});

// ========== SERVE ==========
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`Watchnest addon running on http://localhost:${PORT}`);

// Optionally publish to central (uncomment when ready)
// publishToCentral('https://your-addon-url/manifest.json')
//   .then(() => console.log('Published to Stremio central!'))
//   .catch(console.error);
