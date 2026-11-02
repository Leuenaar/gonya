'use strict';
const { tavilyClient } = require('../tavily');

const WEB_SEARCH_DESCRIPTION =
  'Search the web for current, real-time information — news, prices, recent events, ' +
  'or anything that might have changed since your training data. Only use this when ' +
  'you genuinely need up-to-date information to answer well. For ordinary conversation, ' +
  'just respond normally without searching — searching adds a delay, so only reach for ' +
  'it when it actually matters.';

// Groq (OpenAI-compatible function-calling format)
const webSearchToolGroq = {
  type: 'function',
  function: {
    name: 'web_search',
    description: WEB_SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
};

// Anthropic tool format
const webSearchToolAnthropic = {
  name: 'web_search',
  description: WEB_SEARCH_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
};

// Compact, LLM-friendly summary of top results — this gets fed back into a
// live voice conversation's context, not shown to the user directly, so it
// stays short on purpose (keeps the follow-up LLM call fast). No citation
// numbering — voice has no screen to show clickable sources on.
const performWebSearch = async (query) => {
  if (!query || !query.trim()) return 'No search query provided.';
  try {
    const response = await tavilyClient.search(query, {
      maxResults:    3,
      includeAnswer: true,
    });
    const parts = [];
    if (response.answer) parts.push(`Summary: ${response.answer}`);
    for (const r of (response.results || []).slice(0, 3)) {
      parts.push(`- ${r.title}: ${(r.content || '').slice(0, 300)}`);
    }
    return parts.join('\n') || 'No results found.';
  } catch (err) {
    return `Search failed: ${err.message}`;
  }
};

// ── Text chat variant — numbered + structured for on-screen citations ──
// Returns BOTH a bracket-numbered string for the model to read (so it can
// cite "[3]" inline in its answer) AND a structured `sources` array the
// backend saves to the DB and the frontend renders as clickable cards.
// `startIndex` lets citation numbers keep counting up across multiple
// search calls within the same turn, instead of every call restarting at 1.
const performWebSearchWithSources = async (query, startIndex = 1) => {
  if (!query || !query.trim()) {
    return { resultText: 'No search query provided.', sources: [] };
  }
  try {
    const response = await tavilyClient.search(query, {
      maxResults:    4,
      includeAnswer: true,
    });
    const results = (response.results || []).slice(0, 4);
    const sources = results.map((r, i) => ({
      index:   startIndex + i,
      title:   r.title || 'Untitled',
      snippet: (r.content || '').slice(0, 240),
      url:     r.url || '',
    }));

    const lines = [];
    if (response.answer) lines.push(`Summary: ${response.answer}`);
    for (const s of sources) {
      lines.push(`[${s.index}] ${s.title}: ${s.snippet}`);
    }
    lines.push(
      'When you use any of the information above in your answer, cite it inline ' +
      'using the matching bracket number exactly as shown, e.g. "...grew 4% [2]." ' +
      'Only cite sources you actually used — never cite a number that wasn\'t given to you.'
    );

    return { resultText: lines.join('\n') || 'No results found.', sources };
  } catch (err) {
    return { resultText: `Search failed: ${err.message}`, sources: [] };
  }
};

module.exports = {
  webSearchToolGroq,
  webSearchToolAnthropic,
  performWebSearch,
  performWebSearchWithSources,
};
