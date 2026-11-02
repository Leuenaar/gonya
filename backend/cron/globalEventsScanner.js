'use strict';
const { anthropic }    = require('../lib/anthropic');
const { supabase }     = require('../lib/supabase');
const { fetchNewsForUser } = require('../lib/news');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Scan across all available categories so the daily extraction
// has broad enough coverage for any user's domain or interests
const ALL_CATEGORIES = [
  'Business', 'Technology', 'Science', 'Health',
  'Politics', 'World', 'Marketing', 'Finance',
  'Education', 'Environment', 'Culture', 'Entertainment',
];

// Fetch recent news in both English and Indonesian — a Bank Indonesia rate
// decision or a Jakarta tech conference will only ever show up in ID
// sources, and would otherwise never make it into the shared calendar.
// Each language is capped before combining so EN volume can't crowd ID
// out entirely (or vice versa) before Haiku ever sees it.
const fetchRecentNews = async () => {
  const [en, id] = await Promise.all([
    fetchNewsForUser('en', ALL_CATEGORIES),
    fetchNewsForUser('id', ALL_CATEGORIES),
  ]);
  return [...en.slice(0, 40), ...id.slice(0, 40)];
};

// Extract dated, significant events from news items using Haiku
// Tags topics specifically so personalization can filter later, at zero extra cost
const extractGlobalEvents = async (newsItems) => {
  if (!newsItems.length) return [];

  const newsText = newsItems
    .slice(0, 80)
    .map(n => `[${n.source} / ${n.category}] ${n.title}${n.excerpt ? ': ' + n.excerpt : ''}`)
    .join('\n');

  const today = new Date().toISOString().slice(0, 10);

  const prompt =
    `Today's date is ${today}. Below is a list of recent news headlines across multiple ` +
    `categories, in both English and Indonesian.\n\n` +
    `${newsText}\n\n` +
    `From this list, identify significant events that have a CLEAR, SPECIFIC date ` +
    `(elections, policy deadlines, central bank decisions, product launches, funding rounds, ` +
    `regulatory rulings, summits, conferences, court decisions, etc). ` +
    `Cover ALL relevant domains, not just politics: technology, business/SaaS, health, ` +
    `science, finance, culture, and world affairs all count. ` +
    `Only include events with real calendar significance. Skip vague or ongoing situations without a specific date.\n\n` +
    `Rules:\n` +
    `- Regardless of which language a headline was written in, write the title and summary in English.\n` +
    `- Date must be in YYYY-MM-DD format\n` +
    `- Only include events dated today or in the future, within the next 60 days\n` +
    `- Title must be short, 6 words or less\n` +
    `- Summary must be 1-2 sentences, factual, neutral tone\n` +
    `- category must be EXACTLY one of these 12 values (lowercase): ` +
    `business, technology, science, health, politics, world, marketing, finance, education, environment, culture, entertainment\n` +
    `- tags should be 1-3 specific keywords that capture the topic precisely ` +
    `(examples: "SaaS pricing", "AI regulation", "mental health policy", "central bank rates", ` +
    `"startup funding", "climate policy"). Use lowercase, specific phrases someone might search for.\n` +
    `- Maximum 8 events total. If nothing qualifies, return an empty array.\n` +
    `- Return ONLY a JSON array, no markdown, no explanation.\n\n` +
    `Format: [{ "title": "...", "date": "YYYY-MM-DD", "summary": "...", "category": "...", "tags": ["...", "..."] }]`;

  const completion = await anthropic.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw = completion.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  try {
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('[GlobalEvents] Failed to parse Haiku response');
    return [];
  }
};

// Main scan function — fetch news, extract events, upsert to Supabase
const runGlobalEventsScan = async () => {
  console.log('[GlobalEvents] Starting daily scan...');
  try {
    const news   = await fetchRecentNews();
    console.log(`[GlobalEvents] Fetched ${news.length} news item(s) for analysis.`);

    const events = await extractGlobalEvents(news);

    if (!events.length) {
      console.log('[GlobalEvents] No qualifying events found today.');
      return;
    }

    const rows = events
      .filter(e => e.title && e.date && e.summary)
      .map(e => ({
        title:    e.title,
        date:     e.date,
        summary:  e.summary,
        category: e.category || 'other',
        tags:     Array.isArray(e.tags) ? e.tags : [],
      }));

    if (!rows.length) return;

    const { error } = await supabase
      .from('global_events')
      .upsert(rows, { onConflict: 'date,title', ignoreDuplicates: true });

    if (error) {
      console.error('[GlobalEvents] Insert error:', error.message);
    } else {
      console.log(`[GlobalEvents] Scan complete. ${rows.length} event(s) processed.`);
    }
  } catch (err) {
    console.error('[GlobalEvents] Scan failed:', err.message);
  }
};

module.exports = { runGlobalEventsScan };