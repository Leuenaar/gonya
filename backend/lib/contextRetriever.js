'use strict';
const { supabase }                  = require('./supabase');
const { embedQuery, vectorToString } = require('./embeddings');

/**
 * Find files relevant to a user message using semantic search.
 * Falls back to full-text search if Voyage AI is unavailable.
 * Fire-and-forget safe — never throws.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {number} limit
 * @returns {Promise<Array>}
 */
const retrieveRelevantContext = async (userId, userMessage, limit = 3) => {
  try {
    const queryVector = await embedQuery(userMessage);

    if (queryVector) {
      const { data, error } = await supabase.rpc('search_files_by_embedding', {
        p_user_id:   userId,
        p_embedding: vectorToString(queryVector),
        p_limit:     limit,
      });
      if (!error && data?.length > 0) return data;
    }

    // Fallback — keyword match on extracted text
    const keywords = userMessage.slice(0, 120).replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!keywords) return [];

    const { data } = await supabase
      .from('conversation_files')
      .select('id, file_name, file_type, extracted_text, similarity:extracted_text')
      .eq('user_id', userId)
      .not('extracted_text', 'is', null)
      .ilike('extracted_text', `%${keywords.split(' ')[0]}%`)
      .limit(limit);

    return data || [];
  } catch (err) {
    console.warn('[ContextRetriever] Failed:', err.message);
    return [];
  }
};

module.exports = { retrieveRelevantContext };