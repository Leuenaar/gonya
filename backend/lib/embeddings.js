'use strict';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL   = 'voyage-3-lite';
const VOYAGE_URL     = 'https://api.voyageai.com/v1/embeddings';

/**
 * Generate a single embedding vector for a text string.
 * Uses voyage-3-lite: 512 dimensions, fast, free tier generous.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
const embed = async (text) => {
  if (!text?.trim() || !VOYAGE_API_KEY) return null;

  // Voyage max input is ~120k tokens — truncate safely at 80k chars
  const input = text.slice(0, 80000);

  try {
    const res = await fetch(VOYAGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model:       VOYAGE_MODEL,
        input:       [input],
        input_type:  'document',
      }),
    });

    if (!res.ok) {
      console.warn('[Embeddings] Voyage API error:', res.status);
      return null;
    }

    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.warn('[Embeddings] Failed to generate embedding:', err.message);
    return null;
  }
};

/**
 * Generate an embedding for a user query (different input_type).
 *
 * @param {string} query
 * @returns {Promise<number[]|null>}
 */
const embedQuery = async (query) => {
  if (!query?.trim() || !VOYAGE_API_KEY) return null;

  try {
    const res = await fetch(VOYAGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model:       VOYAGE_MODEL,
        input:       [query.slice(0, 8000)],
        input_type:  'query',
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.warn('[Embeddings] Query embed failed:', err.message);
    return null;
  }
};

/**
 * Format a vector array as a PostgreSQL-compatible string.
 * e.g. [0.1, 0.2, ...] → '[0.1,0.2,...]'
 *
 * @param {number[]} vector
 * @returns {string}
 */
const vectorToString = (vector) => `[${vector.join(',')}]`;

module.exports = { embed, embedQuery, vectorToString };