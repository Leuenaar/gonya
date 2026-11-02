'use strict';
const { supabase } = require('./supabase');

// Only the languages Gonya's Settings actually offers — anything else
// (unset, null, or a value we don't recognize) degrades gracefully to no
// instruction at all, letting the agent fall back to its own default
// rather than forcing a language we can't actually confirm.
const LANGUAGE_NAMES = { id: 'Bahasa Indonesia', en: 'English' };

/**
 * Fetches the given user's language preference (user_profiles.language —
 * the same column personal chat's handler.js already uses) and returns a
 * ready-to-inject system-prompt instruction. Used to bring group chat's
 * agent responses (groupVeraTrigger.js, groupAkselTrigger.js) up to the
 * same language-awareness personal chat already has.
 *
 * Never throws — a lookup failure or unrecognized value just means no
 * instruction gets added, same "don't claim what we can't confirm"
 * principle as lib/liveContext.js.
 */
const getResponseLanguageInstruction = async (userId) => {
  if (!userId) return '';

  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('language')
      .eq('id', userId)
      .maybeSingle();

    const langName = LANGUAGE_NAMES[data?.language];
    if (!langName) return '';

    return `Respond in ${langName}, matching this person's language preference.`;
  } catch (err) {
    console.warn('[AgentLanguage] Failed to fetch language preference (non-fatal):', err.message);
    return '';
  }
};

module.exports = { getResponseLanguageInstruction };