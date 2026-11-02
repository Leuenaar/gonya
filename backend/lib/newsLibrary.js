'use strict';
/**
 * News Collection Library
 *
 * Static curated list of news sources organized by language and category.
 * TheOnes reads this to know what's available, then picks what's relevant
 * for a given user. Never auto-discovers or auto-adds sources.
 *
 * New sources are added only through the quarterly proposal pipeline,
 * reviewed and approved by Leuenaar before being merged here.
 *
 * Source types:
 * - 'rss'  : standard RSS/Atom feed, parsed with rss-parser
 * - 'api'  : dedicated API with its own fetching logic in backend/lib/news.js
 *
 * If requires_key is true, key_env names the .env variable that must exist.
 */

const NEWS_LIBRARY = {
  ID: {
    general: [
      {
        id:           'cnnindonesia',
        name:         'CNN Indonesia',
        type:         'rss',
        url:          'https://www.cnnindonesia.com/rss',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'tempo',
        name:         'Tempo.co',
        type:         'rss',
        url:          'https://rss.tempo.co/',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'detik',
        name:         'Detik.com',
        type:         'rss',
        url:          'https://news.detik.com/rss',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-06',
        note:         'URL updated Jun 2026 — old rss.detik.com/index.php/detikcom discontinued Nov 2020',
      },
    ],

    business: [
      {
        id:           'antara_ekonomi',
        name:         'Antara Ekonomi',
        type:         'rss',
        url:          'https://www.antaranews.com/rss/ekonomi',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-06',
        note:         'Replaced bisnis.com Jun 2026 — bisnis.com does not provide a public RSS feed',
      },
      {
        id:           'cnnindonesia_ekonomi',
        name:         'CNN Indonesia — Ekonomi',
        type:         'rss',
        url:          'https://www.cnnindonesia.com/ekonomi/rss',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-08',
        note:         'Added 29 Aug 2026 — business/technology categories previously had only one source each',
      },
    ],

    technology: [
      {
        id:           'techinasia_id',
        name:         'Tech in Asia (ID)',
        type:         'rss',
        url:          'https://id.techinasia.com/feed',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'cnnindonesia_teknologi',
        name:         'CNN Indonesia — Teknologi',
        type:         'rss',
        url:          'https://www.cnnindonesia.com/teknologi/rss',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-08',
        note:         'Added 29 Aug 2026',
      },
    ],

    science: [
      {
        id:           'antara_tekno',
        name:         'Antara Tekno',
        type:         'rss',
        url:          'https://www.antaranews.com/rss/tekno',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-07',
        note:         'Replaced rss.kompas.com/sains Jul 2026 — Kompas retired their rss.kompas.com subdomain (all paths now 404). Feed confirmed live (200, non-error response) but not visually verified — server returns it as application/octet-stream rather than text/xml.',
        confidence:   'high-unverified-visual',
      },
    ],

    health: [
      {
        id:           'antara_kesehatan',
        name:         'Antara Megapolitan — Kesehatan',
        type:         'rss',
        url:          'https://megapolitan.antaranews.com/rss/kesehatan.xml',
        language:     'id',
        requires_key: false,
        verified_at:  '2026-07',
        note:         'Replaced rss.kompas.com/health Jul 2026 — Kompas retired their rss.kompas.com subdomain (all paths now 404). This is Antara\'s Jakarta-metro edition, so coverage leans Jakarta-area, but content is fetched and confirmed live with current dated articles.',
      },
    ],
  },

  EN: {
    general: [
      {
        id:           'guardian',
        name:         'The Guardian',
        type:         'api',
        key_env:      'GUARDIAN_API_KEY',
        language:     'en',
        requires_key: true,
        note:         'Already integrated in backend/lib/news.js',
        verified_at:  '2026-06',
      },
      {
        id:           'bbc',
        name:         'BBC News',
        type:         'rss',
        url:          'https://feeds.bbci.co.uk/news/rss.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'npr_world',
        name:         'NPR — World',
        type:         'rss',
        url:          'https://feeds.npr.org/1004/rss.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-08',
        note:         'Added 29 Aug 2026',
      },
    ],

    technology: [
      {
        id:           'hackernews',
        name:         'Hacker News',
        type:         'api',
        language:     'en',
        requires_key: false,
        note:         'Already integrated in backend/lib/news.js',
        verified_at:  '2026-06',
      },
      {
        id:           'techcrunch',
        name:         'TechCrunch',
        type:         'rss',
        url:          'https://techcrunch.com/feed/',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'theverge',
        name:         'The Verge',
        type:         'rss',
        url:          'https://www.theverge.com/rss/index.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-06',
      },
    ],

    business: [
      {
        id:           'bbc_business',
        name:         'BBC Business',
        type:         'rss',
        url:          'https://feeds.bbci.co.uk/news/business/rss.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-06',
        note:         'Replaced reuters_business Jun 2026 — Reuters discontinued public RSS feeds',
      },
    ],

    science: [
      {
        id:           'sciencedaily',
        name:         'ScienceDaily',
        type:         'rss',
        url:          'https://www.sciencedaily.com/rss/all.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-06',
      },
      {
        id:           'npr_science',
        name:         'NPR — Science',
        type:         'rss',
        url:          'https://feeds.npr.org/1007/rss.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-08',
        note:         'Added 29 Aug 2026 — this category previously had only one source',
      },
    ],

    health: [
      {
        id:           'guardian_health',
        name:         'The Guardian — Health',
        type:         'api',
        key_env:      'GUARDIAN_API_KEY',
        language:     'en',
        requires_key: true,
        note:         'Uses existing Guardian API key with section=health filter',
        verified_at:  '2026-06',
      },
      {
        id:           'npr_health',
        name:         'NPR — Health',
        type:         'rss',
        url:          'https://feeds.npr.org/1128/rss.xml',
        language:     'en',
        requires_key: false,
        verified_at:  '2026-08',
        note:         'Added 29 Aug 2026 — this category previously depended entirely on the Guardian API key',
      },
    ],

    finance: [
      {
        id:           'guardian_money',
        name:         'The Guardian — Money',
        type:         'api',
        key_env:      'GUARDIAN_API_KEY',
        language:     'en',
        requires_key: true,
        note:         'Uses existing Guardian API key with section=money filter',
        verified_at:  '2026-06',
      },
    ],
  },
};

// Category mapping: radar_categories values → library keys
const CATEGORY_MAP = {
  'Business':      ['business'],
  'Technology':    ['technology'],
  'Science':       ['science'],
  'Health':        ['health'],
  'Politics':      ['general'],
  'World':         ['general'],
  'Marketing':     ['business'],
  'Finance':       ['finance', 'business'],
  'Education':     ['general'],
  'Environment':   ['science', 'general'],
  'Culture':       ['general'],
  'Entertainment': ['general'],
};

/**
 * Returns a flat list of sources relevant to a given user.
 *
 * @param {'id'|'en'} language        - User's language preference.
 * @param {string[]}  radarCategories - User's selected radar categories.
 * @returns {object[]} Deduplicated list of source objects.
 */
const getSourcesForUser = (language = 'id', radarCategories = []) => {
  const lang    = (language || 'id').toLowerCase();
  const pool    = NEWS_LIBRARY[lang.toUpperCase()] || NEWS_LIBRARY['ID'];
  const seen    = new Set();
  const results = [];

  const addFromKeys = (keys) => {
    for (const key of keys) {
      const sources = pool[key] || [];
      for (const src of sources) {
        if (!seen.has(src.id)) {
          seen.add(src.id);
          results.push(src);
        }
      }
    }
  };

  if (radarCategories.length === 0) {
    addFromKeys(['general']);
  } else {
    for (const cat of radarCategories) {
      const keys = CATEGORY_MAP[cat] || ['general'];
      addFromKeys(keys);
    }
  }

  return results;
};

/**
 * Returns all available sources for a language, regardless of category.
 * Used by TheOnes when drafting quarterly proposals.
 *
 * @param {'id'|'en'} language
 * @returns {object[]}
 */
const getAllSourcesForLanguage = (language = 'id') => {
  const lang = (language || 'id').toLowerCase();
  const pool = NEWS_LIBRARY[lang.toUpperCase()] || NEWS_LIBRARY['ID'];
  return Object.values(pool).flat();
};

module.exports = { NEWS_LIBRARY, getSourcesForUser, getAllSourcesForLanguage, CATEGORY_MAP };