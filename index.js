// index.js
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");


// ---------- Configuration ----------
const ADDON_PORT = process.env.PORT || 7000;
const LIMETORRENTS_BASE = "https://www.limetorrents.cc";
// Cinemeta is an official Stremio metadata addon (no key required)
const CINEMETA_BASE = "https://v3-cinemeta.strem.io/meta";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------- Simple in-memory cache for metadata ----------
const metaCache = new Map();

/**
 * Fetch movie / series metadata from Cinemeta.
 * @param {"movie"|"series"} type
 * @param {string} imdbId  e.g. "tt1234567"
 * @returns {object|null}  { name, year, ... } or null
 */
async function fetchMeta(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

  try {
    const url = `${CINEMETA_BASE}/${type}/${imdbId}.json`;
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT },
    });
    const meta = data?.meta;
    if (meta) {
      metaCache.set(cacheKey, meta);
      return meta;
    }
  } catch (err) {
    console.error(`Failed to fetch metadata for ${imdbId}:`, err.message);
  }
  return null;
}

/**
 * Build a search query string for Limetorrents.
 * @param {"movie"|"series"} type
 * @param {string} fullId  e.g. "tt1234567" or "tt1234567:1:2"
 * @returns {Promise<string|null>}  query string or null if metadata missing
 */
async function buildSearchQuery(type, fullId) {
  if (type === "movie") {
    const meta = await fetchMeta("movie", fullId);
    if (!meta) return null;
    // combine name + year for better results
    const year = meta.year ? ` ${meta.year}` : "";
    return `${meta.name}${year}`.trim();
  }

  // series: id format "tt1234567:SEASON:EPISODE"
  const parts = fullId.split(":");
  if (parts.length < 3) return null; // need season & episode
  const [seriesId, season, episode] = parts;
  const meta = await fetchMeta("series", seriesId);
  if (!meta) return null;

  const s = season.padStart(2, "0");
  const e = episode.padStart(2, "0");
  // typical scene format: "Show Name S01E02"
  return `${meta.name} S${s}E${e}`;
}

/**
 * Scrape Limetorrents search results.
 * @param {string} query
 * @returns {Promise<Array<{title:string, magnet:string, size:string, seeds:number}>>}
 */
async function scrapeLimetorrents(query) {
  // Limetorrents search URL: /search/all/<encoded-query>/
  const searchUrl = `${LIMETORRENTS_BASE}/search/all/${encodeURIComponent(query)}/`;
  console.log(`Scraping: ${searchUrl}`);

  let html;
  try {
    const resp = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
    });
    html = resp.data;
  } catch (err) {
    console.error("Search request failed:", err.message);
    return [];
  }

  const $ = cheerio.load(html);
  const results = [];

  // Limetorrents results table usually has class "table2".
  // Each row contains: name, size, seeds, leechers, health, magnet link.
  $("table.table2 tr").each((_, row) => {
    const magnetAnchor = $(row).find('a[href^="magnet:"]');
    if (magnetAnchor.length === 0) return;

    const magnet = magnetAnchor.attr("href");
    // title is inside the first tdleft column
    const title = $(row).find("td.tdleft a").first().text().trim();
    // the next columns are tdnormal: size, seeds, leechers ...
    const normTds = $(row).find("td.tdnormal");
    const size = normTds.eq(0).text().trim();
    const seedsText = normTds.eq(1).text().trim();
    const seeds = parseInt(seedsText.replace(/,/g, ""), 10) || 0;

    if (title && magnet) {
      results.push({ title, magnet, size, seeds });
    }
  });

  // Sort by seeders descending, take top 25
  results.sort((a, b) => b.seeds - a.seeds);
  return results.slice(0, 25);
}

/**
 * Extract infoHash from a magnet link.
 * @param {string} magnet
 * @returns {string|null}  hex info hash or null
 */
function extractInfoHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
}

// ---------- Addon Manifest ----------
const manifest = {
  id: "community.limetorrents",
  version: "1.0.0",
  name: "LimeTorrents Addon",
  description: "Stream movies & series from LimeTorrents.cc",
  resources: ["stream"], // we only provide stream links
  types: ["movie", "series"],
  idPrefixes: ["tt"],    // IMDB ids
  catalogs: [],
  behaviorHints: {
    configurable: false,
    adult: false,
  },
};

// ---------- Stream Handler ----------
async function streamHandler({ type, id }) {
  console.log(`Stream request: type=${type}, id=${id}`);
  const streams = [];

  try {
    // 1) Build search query from metadata
    const query = await buildSearchQuery(type, id);
    if (!query) {
      console.log("Could not build search query (metadata missing)");
      return { streams };
    }

    // 2) Scrape LimeTorrents
    const results = await scrapeLimetorrents(query);
    if (!results.length) {
      // fallback: try search with IMDB id directly (some uploads include it)
      const fallbackResults = await scrapeLimetorrents(id);
      results.push(...fallbackResults);
    }

    // 3) Convert to Stremio stream objects
    results.forEach((r) => {
      const infoHash = extractInfoHash(r.magnet);
      streams.push({
        title: `📦 LimeTorrents\n${r.title}\n💾 ${r.size}  |  🔼 ${r.seeds} seeds`,
        url: r.magnet,
        infoHash: infoHash,
        // indicate this is a torrent stream (not directly playable in web)
        behaviorHints: { notWebReady: true },
      });
    });
  } catch (err) {
    console.error("Stream handler error:", err);
  }

  console.log(`Returning ${streams.length} streams`);
  return { streams };
}

// --------- Create and start the addon ---------
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(streamHandler);

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
