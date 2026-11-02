'use strict';

const { getSourcesForUser } = require('./newsLibrary');

const GUARDIAN_KEY = process.env.GUARDIAN_API_KEY;
const GUARDIAN_BASE = 'https://content.guardianapis.com';

// ── Guardian section map ──────────────────────────────────
const GUARDIAN_SECTIONS = {
  'Business':     'business',
  'Technology':   'technology',
  'Science':      'science',
  'Health':       'society',
  'Politics':     'politics',
  'World':        'world',
  'Marketing':    'business',
  'Finance':      'money',
  'Education':    'education',
  'Environment':  'environment',
  'Culture':      'culture',
  'Entertainment':'film',
};

// ── Simple in-memory cache ────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const getCache = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
};

const setCache = (key, data) => cache.set(key, { data, ts: Date.now() });

// ── Fetch from Guardian API ───────────────────────────────
const fetchGuardian = async (section, pageSize = 8) => {
  const cacheKey = `guardian_${section}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `${GUARDIAN_BASE}/search?section=${section}&page-size=${pageSize}&order-by=newest&api-key=${GUARDIAN_KEY}&show-fields=trailText`;
    const res  = await fetch(url);
    const data = await res.json();

    const items = (data?.response?.results || []).map(a => ({
    source:   'The Guardian',
    tag:      '',
    title:    a.webTitle,
    excerpt:  a.fields?.trailText
        ? a.fields.trailText.replace(/<[^>]*>/g, '').slice(0, 130) + '...'
        : '',
    url:      a.webUrl,
    time:     timeAgo(a.webPublicationDate),
    category: section,
    }));

    setCache(cacheKey, items);
    return items;
  } catch (err) {
    console.error(`[News] Guardian error (${section}):`, err.message);
    return [];
  }
};

// ── Fetch from Hacker News ────────────────────────────────
// NOTE: excerpt intentionally left empty here — the Firebase Items API
// only returns title/url/score/time/etc, never a body or summary, so
// there is genuinely nothing to show. This is honest, not a bug (see
// fetchRSS() below for the field that WAS a real bug).
const fetchHackerNews = async (pageSize = 8) => {
  const cacheKey = 'hn_top';
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const res   = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids   = await res.json();
    const top   = ids.slice(0, pageSize);

    const stories = await Promise.all(
      top.map(async id => {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        return r.json();
      })
    );

    const items = stories
      .filter(s => s && s.title && s.url)
      .map(s => ({
        source:   'HN',
        tag:      s.score > 200 ? 'HOT' : '',
        title:    s.title,
        url:      s.url,
        time:     timeAgo(new Date(s.time * 1000).toISOString()),
        category: 'Technology',
      }));

    setCache(cacheKey, items);
    return items;
  } catch (err) {
    console.error('[News] HN error:', err.message);
    return [];
  }
};

// ── Fetch custom RSS feed ─────────────────────────────────
const fetchRSS = async (feedUrl, name, category) => {
  const cacheKey = `rss_${feedUrl}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const RSSParser = require('rss-parser');
    // Some sites (Kontan, Tech in Asia ID, others) 403 requests that don't
    // look like a real browser/feed-reader — rss-parser sends no
    // User-Agent by default, which trips that check on several sources.
    const parser = new RSSParser({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    const feed = await parser.parseURL(feedUrl);

    const items = (feed.items || []).slice(0, 6).map(item => {
      // Bug fixed (29 Aug 2026): excerpt was never populated for ANY RSS
      // source (only Guardian's separate API path set this field before)
      // — meaning almost every source in the app (BBC, TechCrunch, The
      // Verge, ScienceDaily, CNN Indonesia, Tempo, Detik, Antara, Tech in
      // Asia ID, and everything added below) always rendered as a bare
      // headline with nothing underneath. rss-parser already extracts a
      // plain-text snippet per item via contentSnippet; falling back to
      // a stripped/truncated `content` for the rare feed that omits
      // contentSnippet but still includes a body. Matches the same
      // ~130-char truncation Guardian's path already used, for visual
      // consistency across all sources.
      const rawExcerpt = item.contentSnippet
        || (item.content ? item.content.replace(/<[^>]*>/g, '') : '');
      const trimmed = rawExcerpt.trim();
      const excerpt = trimmed
        ? trimmed.slice(0, 130) + (trimmed.length > 130 ? '...' : '')
        : '';

      return {
        source:   name,
        tag:      '',
        title:    item.title || '',
        excerpt,
        url:      item.link  || '',
        time:     item.pubDate ? timeAgo(item.pubDate) : '',
        category,
      };
    });

    setCache(cacheKey, items);
    return items;
  } catch (err) {
    console.error(`[News] RSS error (${feedUrl}):`, err.message);
    return [];
  }
};

// ── Fetch news for Macro Intel ────────────────────────────
const fetchMacroNews = async (categories = []) => {
  const results = [];

  for (const cat of categories) {
    const section = GUARDIAN_SECTIONS[cat];
    if (!section) continue;

    // Tech categories also get HN articles
    if (cat === 'Technology') {
      const hn = await fetchHackerNews(5);
      results.push(...hn);
    }

    const guardian = await fetchGuardian(section, 6);
    results.push(...guardian.map(a => ({ ...a, category: cat })));
  }

  // Deduplicate by title
  const seen  = new Set();
  const dedup = results.filter(a => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });

  return dedup;
};

// ── Dispatch a single newsLibrary.js source definition to the right
//    low-level fetcher. 'rss' sources go through fetchRSS as-is; 'api'
//    sources map to the Guardian/HN fetchers already used above — the
//    Guardian section comes from the same GUARDIAN_SECTIONS table so both
//    paths stay consistent with each other.
const fetchFromLibrarySource = async (source, cat, pageSize = 6) => {
  if (source.type === 'rss') {
    return fetchRSS(source.url, source.name, cat);
  }
  if (source.type === 'api') {
    if (source.id === 'hackernews') return fetchHackerNews(pageSize);
    // Guardian-backed library entries: guardian, guardian_health, guardian_money
    const section = GUARDIAN_SECTIONS[cat] || 'world';
    const items = await fetchGuardian(section, pageSize);
    return items.map(i => ({ ...i, source: source.name }));
  }
  return [];
};

// Round-robin interleave items from multiple sources into one list, so
// no single source crowds out every other one before any downstream
// display-count limit (e.g. the frontend's own slice(0, 6)) gets a
// chance to see them. Bug fixed 29 Aug 2026 — confirmed in testing that
// Micro Radar looked "Hacker News only" even when TechCrunch/The Verge
// were being fetched correctly: HN was simply always first in line
// because of ordinary array-push order, and its own item count (up to 8)
// alone was enough to fill the frontend's whole display limit before the
// other sources' items were ever reached.
// Input: an array of arrays (one per source). Output: a single flat
// array with item 0 from every source first, then item 1 from every
// source, and so on.
const interleaveBySource = (itemGroups) => {
  const result = [];
  let index = 0;
  let addedAny = true;
  while (addedAny) {
    addedAny = false;
    for (const group of itemGroups) {
      if (index < group.length) {
        result.push(group[index]);
        addedAny = true;
      }
    }
    index++;
  }
  return result;
};

// ── Fetch news for Macro Intel, language + category aware ────
// Replaces the old "always Guardian/HN" path — for ID users this pulls
// CNN Indonesia / Tempo / Detik / Antara etc. from newsLibrary.js
// instead. EN users still land on Guardian/HN plus whatever else
// newsLibrary.js lists for EN (BBC, TechCrunch, The Verge, ScienceDaily,
// NPR, and everything added 29 Aug 2026).
const fetchNewsForUser = async (language, categories = []) => {
  const cats       = categories.length > 0 ? categories : ['World'];
  const itemGroups = [];

  for (const cat of cats) {
    const sources = getSourcesForUser(language, [cat]);
    for (const src of sources) {
      const items = await fetchFromLibrarySource(src, cat, 6);
      itemGroups.push(items.map(item => ({ ...item, category: cat })));
    }
  }

  // Interleaved (29 Aug 2026) — see interleaveBySource()'s comment above.
  const interleaved = interleaveBySource(itemGroups);

  // Deduplicate by title
  const seen = new Set();
  return interleaved.filter(a => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });
};

// ── Fetch news for Micro Radar ────────────────────────────
const fetchRadarNews = async (domain, customSources = []) => {
  const results = [];

  // Domain-based Guardian section
  const domainLower = (domain || '').toLowerCase();
  let section = 'technology';
  if (domainLower.includes('saas') || domainLower.includes('software'))  section = 'technology';
  if (domainLower.includes('business') || domainLower.includes('startup')) section = 'business';
  if (domainLower.includes('finance') || domainLower.includes('invest'))   section = 'money';
  if (domainLower.includes('health'))   section = 'society';
  if (domainLower.includes('research') || domainLower.includes('science'))  section = 'science';
  if (domainLower.includes('market'))   section = 'business';

  const guardian = await fetchGuardian(section, 8);
  results.push(...guardian);

  const hn = await fetchHackerNews(6);
  results.push(...hn);

  // Custom RSS feeds
  for (const source of customSources) {
    const rss = await fetchRSS(source.url, source.name, source.category);
    results.push(...rss);
  }

  // Deduplicate
  const seen  = new Set();
  return results.filter(a => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });
};

// ── Fetch news for Micro Radar, language + domain aware ────
// Same domain heuristic as fetchRadarNews above, just expressed as a
// radar-category label instead of a raw Guardian section so it can drive
// newsLibrary.js too (ID users get CNN Indonesia/Tempo/etc. instead of
// always landing on Guardian/HN).
const fetchRadarNewsForUser = async (language, domain, customSources = []) => {
  const itemGroups = [];

  const domainLower = (domain || '').toLowerCase();
  let category = 'Technology';
  if (domainLower.includes('saas') || domainLower.includes('software'))    category = 'Technology';
  if (domainLower.includes('business') || domainLower.includes('startup')) category = 'Business';
  if (domainLower.includes('finance') || domainLower.includes('invest'))   category = 'Finance';
  if (domainLower.includes('health'))                                     category = 'Health';
  if (domainLower.includes('research') || domainLower.includes('science')) category = 'Science';
  if (domainLower.includes('market'))                                     category = 'Business';

  const sources = getSourcesForUser(language, [category]);
  for (const src of sources) {
    const items = await fetchFromLibrarySource(src, category, 8);
    itemGroups.push(items.map(item => ({ ...item, category })));
  }

  // HN stays EN-only — forcing English tech news into an Indonesian radar
  // feed would defeat the point of this fix. EN users already get it via
  // newsLibrary.js's Technology list when category === 'Technology'; this
  // covers the other categories too, matching the old always-on behavior.
  if ((language || 'id').toLowerCase() === 'en') {
    itemGroups.push(await fetchHackerNews(6));
  }

  // User's own custom RSS feeds — language-agnostic, always included
  for (const source of customSources) {
    itemGroups.push(await fetchRSS(source.url, source.name, source.category));
  }

  // Interleaved (29 Aug 2026) — see interleaveBySource()'s comment above.
  // This is the fix for "Micro Radar looks HN-only": every source now
  // gets a fair turn near the front of the list instead of whichever
  // source happened to be fetched/pushed first taking every slot.
  const interleaved = interleaveBySource(itemGroups);

  const seen = new Set();
  return interleaved.filter(a => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });
};

// ── Utility — time ago ────────────────────────────────────
const timeAgo = (dateStr) => {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60)  return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs  < 24)  return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  } catch {
    return '';
  }
};

module.exports = { fetchMacroNews, fetchRadarNews, fetchRSS, fetchNewsForUser, fetchRadarNewsForUser };
