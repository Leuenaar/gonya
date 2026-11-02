'use strict';
/**
 * FILE-INTENT REPAIR LAYER
 *
 * Backstop for a real failure mode: an agent (especially Aksel/Llama,
 * observed to be less reliable at this than Vera/Claude) says something
 * like "I'll generate the file for you" or "here's your document" but
 * never actually emits the [[GENERATE_FILE:...]] marker. Without this,
 * the user gets an empty promise and no file ever arrives.
 *
 * Two-stage cost control, same shape as crisisDetector.js:
 *   1. Cheap keyword pre-filter (no API call) — only messages that even
 *      plausibly express file-creation intent get to stage 2.
 *   2. Haiku classifier confirms intent and extracts what the file
 *      should actually be, IF the pre-filter matched.
 *
 * This is a deliberate backstop, not the primary mechanism — the
 * marker syntax in the system prompt (FILE_GENERATION_DIRECTIVE in
 * handler.js) is what SHOULD fire. This only exists because that
 * doesn't fire reliably 100% of the time, especially on Groq/Llama.
 *
 * Trigger widened (24 Aug 2026): the ORIGINAL keyword pre-filter only
 * checked the AGENT's OWN response text for claim-language ("I'm
 * generating a file..."). Confirmed in practice this misses a real,
 * fairly common failure mode: the agent is asked for a specific file
 * format, and instead of using the marker, just writes the requested
 * content DIRECTLY as inline text (e.g. a markdown table) with ZERO
 * mention of files/generating/creating at all — no claim-language for
 * the old keyword filter to ever match against. `userRequestedFileFormat`
 * checks the USER's own message instead, which is a much more reliable
 * signal: if they explicitly asked for "format .pdf" or similar, a
 * missing marker means something went wrong regardless of how the
 * agent's response is worded. Both checks now feed into the SAME
 * backstop as an OR — broadening coverage without removing the original
 * safety net.
 */
const { anthropic } = require('../anthropic');
const { logUsage }  = require('../usageLogger');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Cheap pre-filter — only escalate to a Haiku call if the message
// plausibly claims to have made/be making a file. Deliberately broad
// (a few false positives triggering an unnecessary Haiku call is far
// cheaper than missing a real one).
const INTENT_KEYWORDS = /\b(generat(?:e|ing|ed)|creat(?:e|ing|ed)|draft(?:ing|ed)?|attach(?:ing|ed)?|prepar(?:e|ing|ed)|put(?:ting)? together|build(?:ing)?)\b[^.!?]{0,50}\b(file|document|doc|pdf|spreadsheet|excel|xlsx|csv|proposal|report|script)\b/i;

// Bug fixed (3 Sep 2026): confirmed via real testing — Indonesian
// requests using the far more common "bikin"/"bikinin" ("make") or
// "buat"/"buatkan" ("make/create for me") were silently missed
// entirely. The OLD pattern `buatin?` is regex syntax for "buati" or
// "buatin" specifically (the `?` only makes the single preceding "n"
// optional) — it never matched "buat" alone, "buatkan", or ANY form of
// "bikin" at all, despite those being everyday phrasing ("bikinin file
// pdf dong", "tolong buatkan laporan dalam excel"). Both verb families
// now cover their common suffixed forms explicitly. While testing this,
// also found the SAME class of gap on the English side — "make this as
// a spreadsheet" / "generate a report as a pdf" were never covered
// either (no "as a" trigger phrase existed) — added alongside the fix.
const FILE_FORMAT_REQUEST = /\.(pdf|docx?|xlsx?|csv|pptx?|txt|md)\b|\b(format|dalam bentuk|sebagai file|jadi file|buat(?:in|kan)?|bikin(?:in|kan)?|as an?)\b[^.!?]{0,30}\b(pdf|docx?|xlsx?|excel|spreadsheet|word|csv|powerpoint)\b/i;

const REPAIR_SYSTEM =
  'You are a backstop classifier for a chat platform. An AI agent was asked for a downloadable ' +
  'file but the pipeline suspects it may not have actually produced one — either the agent CLAIMED ' +
  'to have made a file, or the user explicitly asked for a specific file format and the agent just ' +
  'answered inline instead. Your job is to recover what the file should be from BOTH the user\'s ' +
  'original request and the agent\'s response.\n\n' +
  'Respond ONLY with valid JSON:\n' +
  '{"intended": true|false, "format": "extension or null", "title": "short title or null", "description": "one sentence describing the content, or null"}\n\n' +
  'format must be one of: docx, pdf, xlsx, csv, js, ts, py, css, html, json, md, sql, txt — ' +
  'PREFER a format explicitly stated in the user\'s own request over guessing from the agent\'s ' +
  'response content-type. If the user asked for "pdf" but the agent\'s response reads like a ' +
  'generic proposal, the answer is still pdf, not docx.\n\n' +
  'If neither the user\'s request nor the agent\'s response actually indicates a file should have ' +
  'been produced (e.g. it\'s just discussing files in the abstract, or asking a question about one), ' +
  'respond {"intended": false, "format": null, "title": null, "description": null}.';

/**
 * Cheap synchronous check — call this first. Only proceed to the
 * (paid) Haiku call if this returns true. Checks the AGENT's response
 * for claim-language (the original signal).
 */
const mightHaveMissedIntent = (content) => INTENT_KEYWORDS.test(content);

/**
 * NEW (24 Aug 2026) — cheap synchronous check against the USER's OWN
 * message for an explicit file-format request. Also free/synchronous,
 * meant to be OR'd together with mightHaveMissedIntent() by the caller
 * so either signal alone is enough to warrant a (still paid, still
 * confirmed by Haiku) repair attempt.
 */
const userRequestedFileFormat = (userMessage) => FILE_FORMAT_REQUEST.test(userMessage || '');

/**
 * Confirm and recover missed file-generation intent via Haiku.
 * Returns { intended, format, title, description }. Fails closed
 * (intended: false) on any error — this is a backstop for a backstop,
 * so silence on failure is the safe default, not an escalation.
 *
 * @param {string} content - the agent's response text
 * @param {string} userId - for usage logging
 * @param {string} [userMessage] - the user's original request, when
 *   available — passed through (24 Aug 2026) so the classifier can
 *   recover an explicitly-requested format even when the agent's own
 *   response gives no hint of one at all.
 */
const detectMissedFileIntent = async (content, userId, userMessage = '') => {
  try {
    const classifierInput = userMessage
      ? `User's original request:\n"${userMessage}"\n\nAgent's response:\n"${content}"`
      : content; // backward compatible — still works if a caller doesn't pass userMessage

    const response = await anthropic.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 150,
      system:     REPAIR_SYSTEM,
      messages:   [{ role: 'user', content: classifierInput }],
    });

    logUsage({
      model:        HAIKU_MODEL,
      callType:     'file_intent_repair',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const raw   = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in repair classifier response');

    const parsed = JSON.parse(match[0]);
    return {
      intended:    !!parsed.intended,
      format:      parsed.format      || null,
      title:       parsed.title       || null,
      description: parsed.description || null,
    };
  } catch (err) {
    console.error('[FileIntentRepair] Error:', err.message);
    return { intended: false, format: null, title: null, description: null };
  }
};

module.exports = { mightHaveMissedIntent, userRequestedFileFormat, detectMissedFileIntent };
