'use strict';
const { supabase } = require('../lib/supabase');

const SIMILARITY_THRESHOLD = 0.75;

/**
 * Search knowledge registry for matching domain
 * Returns: { type: 'hit'|'hybrid'|'miss', data: {...}|null, score: number }
 */
const searchRegistry = async (normalizedDomain) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_registry')
      .select('*')
      .ilike('normalized_domain', `%${normalizedDomain}%`)
      .order('hit_count', { ascending: false })
      .limit(3);

    if (error) throw error;

    if (data && data.length > 0) {
      const best  = data[0];
      const score = calculateTextSimilarity(normalizedDomain, best.normalized_domain);

      if (score >= SIMILARITY_THRESHOLD) {
        await supabase
          .from('knowledge_registry')
          .update({ hit_count: best.hit_count + 1, last_accessed: new Date().toISOString() })
          .eq('id', best.id);

        return { type: 'hit', data: best, score };
      }

      if (score >= 0.4) {
        return { type: 'hybrid', data: best, score };
      }
    }

    return { type: 'miss', data: null, score: 0 };
  } catch (err) {
    console.error('[TheOnes] searchRegistry error:', err.message);
    return { type: 'miss', data: null, score: 0 };
  }
};

/**
 * Save new entry to knowledge registry
 */
const saveToRegistry = async ({ domain, normalizedDomain, category, subcategory, akselKnowledge, veraKnowledge }) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_registry')
      .insert([{
        domain,
        normalized_domain: normalizedDomain,
        category:          category || null,
        aksel_knowledge:   akselKnowledge,
        vera_knowledge:    veraKnowledge,
        hit_count:         0,
        last_accessed:     new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;
    console.log(`[TheOnes] Registry: saved new domain "${domain}"`);
    return data;
  } catch (err) {
    console.error('[TheOnes] saveToRegistry error:', err.message);
    return null;
  }
};

/**
 * Simple text similarity score (0-1)
 */
const calculateTextSimilarity = (a, b) => {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Normalize domain input for consistent matching
 */
const normalizeDomain = (input) => {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Evaluate input relevance before saving to registry
 * Blocks: too short, gibberish, repeated characters
 * Allows: single meaningful words (SaaS, Marketing, etc.)
 */
const evaluateRelevance = (input) => {
  const trimmed = input.trim();

  // Minimum 3 characters
  if (trimmed.length < 3) {
    return { valid: false, reason: 'too_short' };
  }

  // Must contain at least one letter or number
  if (!/[a-zA-Z0-9]/.test(trimmed)) {
    return { valid: false, reason: 'gibberish' };
  }

  // Block repeated characters (aaaaaaa, !!!!!!)
  if (/(.)\1{4,}/.test(trimmed)) {
    return { valid: false, reason: 'gibberish' };
  }

  return { valid: true };
};

module.exports = { searchRegistry, saveToRegistry, normalizeDomain, evaluateRelevance };