'use strict';
/**
 * FILE GENERATION ARCHITECT
 *
 * Takes a brief intent (format + title + description + conversation
 * context) and expands it into a full, schema-valid structure ready
 * for one of the renderers. This is the "thinking" step — renderers
 * are dumb by design, they just mechanically turn a validated
 * structure into bytes.
 *
 * Uses Vera's model (Sonnet) since this needs real reasoning to
 * produce a coherent document — a title and a one-line description
 * has to become an actual structured proposal/report/spreadsheet.
 *
 * Self-correction: if the model's JSON fails schema validation, we
 * feed the validation errors back and ask it to fix them, once. Two
 * attempts total — enough to catch the common case (a malformed
 * table row, a missing field) without letting cost run away on a
 * model that's fundamentally confused about the task.
 */
const { anthropic } = require('../anthropic');
const { logUsage }  = require('../usageLogger');
const { validateDocument }    = require('./schemas/documentSchema');
const { validateSpreadsheet } = require('./schemas/spreadsheetSchema');

const ARCHITECT_MODEL = process.env.VERA_MODEL || 'claude-sonnet-4-6';
const MAX_ATTEMPTS     = 2;

// Which schema category each extension belongs to.
const FORMAT_CATEGORY = {
  docx: 'document', pdf: 'document', md: 'document',
  xlsx: 'spreadsheet', csv: 'spreadsheet',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code',
  css: 'code', html: 'code', json: 'code', yaml: 'code', yml: 'code',
  sql: 'code', sh: 'code', txt: 'code',
};

const categoryFor = (format) => FORMAT_CATEGORY[format.toLowerCase()] || 'code';

// ── Schema explanations given to the model ─────────────────────────────────

const DOCUMENT_SCHEMA_GUIDE = `
Produce a JSON object with this exact shape:
{
  "title": "string",
  "subtitle": "string (optional)",
  "blocks": [
    { "type": "heading", "level": 1-4, "text": "string" },
    { "type": "paragraph", "text": "string", "emphasis": "bold"|"italic"|"none" (optional) },
    { "type": "list", "ordered": true|false, "items": ["string", ...] },
    { "type": "table", "headers": ["string", ...], "rows": [["string", ...], ...] },
    { "type": "quote", "text": "string" },
    { "type": "pageBreak" },
    { "type": "spacer" }
  ]
}
Rules: every table row must have exactly as many cells as there are headers.
Write real, substantive content — not placeholders. A proposal/report should
read like something a professional would actually send.`.trim();

const SPREADSHEET_SCHEMA_GUIDE = `
Produce a JSON object with this exact shape:
{
  "filename": "string (no extension, e.g. 'q3-budget')",
  "sheets": [
    {
      "name": "string (sheet tab name)",
      "columns": [{ "header": "string", "type": "string"|"number"|"date"|"currency"|"percent" }],
      "rows": [[value, value, ...], ...]
    }
  ]
}
Rules: every row array must have exactly as many values as there are columns,
in the same order. Use realistic, substantive data — not placeholder rows.
Number/currency/percent columns should contain actual numbers, not strings.`.trim();

const CODE_SCHEMA_GUIDE = `
Produce a JSON object with this exact shape:
{
  "filename": "string (with extension, e.g. 'script.js')",
  "content": "string (the full file content)"
}
Write complete, working content — not a stub or placeholder.`.trim();

const SCHEMA_GUIDES = {
  document:    DOCUMENT_SCHEMA_GUIDE,
  spreadsheet: SPREADSHEET_SCHEMA_GUIDE,
  code:        CODE_SCHEMA_GUIDE,
};

const validateForCategory = (category, data) => {
  if (category === 'document')    return validateDocument(data);
  if (category === 'spreadsheet') return validateSpreadsheet(data);
  // code category: light validation, not a full schema
  if (typeof data?.filename !== 'string' || !data.filename.trim())
    return { valid: false, errors: ['filename is required'] };
  if (typeof data?.content !== 'string' || !data.content.trim())
    return { valid: false, errors: ['content is required'] };
  return { valid: true, errors: [] };
};

const extractJson = (text) => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
};

const buildPrompt = (category, { title, description, context }, priorAttempt) => {
  const parts = [
    `You are the Document Architect for Gonya. A user asked for a file to be generated.`,
    `Format category: ${category}`,
    `Requested title: ${title}`,
    `Description of what's needed: ${description}`,
  ];

  if (context) {
    parts.push(`Relevant conversation context:\n${context}`);
  }

  parts.push(SCHEMA_GUIDES[category]);
  parts.push('Respond ONLY with the JSON object — no markdown fences, no explanation before or after.');

  if (priorAttempt) {
    parts.push(
      `\nYour previous attempt failed validation with these errors:\n` +
      priorAttempt.errors.join('\n') +
      `\n\nHere was your previous output:\n${JSON.stringify(priorAttempt.data)}\n\n` +
      `Fix these specific issues and respond with the corrected JSON object only.`
    );
  }

  return parts.join('\n\n');
};

/**
 * Run the architect. Returns { category, data } on success.
 * Throws if validation still fails after MAX_ATTEMPTS.
 */
const runArchitect = async ({ format, title, description, context, userId }) => {
  const category = categoryFor(format);
  let priorAttempt = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = buildPrompt(category, { title, description, context }, priorAttempt);

    const response = await anthropic.messages.create({
      model:      ARCHITECT_MODEL,
      max_tokens: 4000,
      messages:   [{ role: 'user', content: prompt }],
    });

    logUsage({
      model:        ARCHITECT_MODEL,
      callType:     'file_architect',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    let data;
    try {
      data = extractJson(text);
    } catch (err) {
      priorAttempt = { errors: [err.message], data: null };
      continue; // no parseable JSON at all — retry once
    }

    const { valid, errors } = validateForCategory(category, data);
    if (valid) {
      return { category, data };
    }

    priorAttempt = { errors, data };
    console.warn(`[Architect] Attempt ${attempt} failed validation:`, errors.join('; '));
  }

  throw new Error(
    `Architect failed to produce a valid ${category} after ${MAX_ATTEMPTS} attempts: ` +
    (priorAttempt?.errors || []).join('; ')
  );
};

module.exports = { runArchitect, categoryFor };