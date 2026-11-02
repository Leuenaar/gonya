'use strict';
/**
 * UNIVERSAL DOCUMENT SCHEMA
 *
 * One content model, rendered to .docx, .pdf, or .md by different
 * renderers (renderers/docxRenderer.js, pdfRenderer.js, etc). The AI
 * (Document Architect) only ever needs to think in terms of this
 * schema — it never needs to know how a table looks in a PDF vs a
 * Word doc. That's the renderer's job.
 *
 * A document is a flat, ordered list of "blocks". Each block is one
 * of a fixed set of types. This is deliberately NOT a nested tree
 * (no sections-within-sections) — flat lists are far more reliable
 * for an LLM to generate correctly and far easier to validate.
 *
 * Supported block types:
 *   heading    — { type: 'heading', level: 1-4, text }
 *   paragraph  — { type: 'paragraph', text, emphasis?: 'bold'|'italic'|'none' }
 *   list       — { type: 'list', ordered: boolean, items: string[] }
 *   table      — { type: 'table', headers: string[], rows: string[][] }
 *   quote      — { type: 'quote', text }
 *   pageBreak  — { type: 'pageBreak' }
 *   spacer     — { type: 'spacer' }
 */

const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'table', 'quote', 'pageBreak', 'spacer'];

/**
 * Validates a single block. Returns { valid, error } — never throws,
 * since this runs on AI output that may be malformed and we want a
 * clear error message back to the architect rather than a crash.
 */
const validateBlock = (block, index) => {
  if (!block || typeof block !== 'object') {
    return { valid: false, error: `Block ${index}: not an object` };
  }
  if (!BLOCK_TYPES.includes(block.type)) {
    return { valid: false, error: `Block ${index}: unknown type "${block.type}"` };
  }

  switch (block.type) {
    case 'heading':
      if (typeof block.text !== 'string' || !block.text.trim())
        return { valid: false, error: `Block ${index} (heading): missing text` };
      if (![1, 2, 3, 4].includes(block.level))
        return { valid: false, error: `Block ${index} (heading): level must be 1-4` };
      break;

    case 'paragraph':
      if (typeof block.text !== 'string' || !block.text.trim())
        return { valid: false, error: `Block ${index} (paragraph): missing text` };
      break;

    case 'list':
      if (!Array.isArray(block.items) || block.items.length === 0)
        return { valid: false, error: `Block ${index} (list): items must be a non-empty array` };
      if (block.items.some(i => typeof i !== 'string'))
        return { valid: false, error: `Block ${index} (list): all items must be strings` };
      break;

    case 'table':
      if (!Array.isArray(block.headers) || block.headers.length === 0)
        return { valid: false, error: `Block ${index} (table): headers must be a non-empty array` };
      if (!Array.isArray(block.rows))
        return { valid: false, error: `Block ${index} (table): rows must be an array` };
      if (block.rows.some(row => !Array.isArray(row) || row.length !== block.headers.length))
        return { valid: false, error: `Block ${index} (table): every row must match headers length` };
      break;

    case 'quote':
      if (typeof block.text !== 'string' || !block.text.trim())
        return { valid: false, error: `Block ${index} (quote): missing text` };
      break;

    case 'pageBreak':
    case 'spacer':
      break; // no fields required
  }

  return { valid: true };
};

/**
 * Validates a full document object.
 * Returns { valid, errors: string[] }.
 */
const validateDocument = (doc) => {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['Document is not an object'] };
  }
  if (typeof doc.title !== 'string' || !doc.title.trim()) {
    errors.push('Document title is required');
  }
  if (!Array.isArray(doc.blocks) || doc.blocks.length === 0) {
    errors.push('Document must have a non-empty blocks array');
  } else {
    doc.blocks.forEach((block, i) => {
      const result = validateBlock(block, i);
      if (!result.valid) errors.push(result.error);
    });
  }

  return { valid: errors.length === 0, errors };
};

module.exports = { BLOCK_TYPES, validateBlock, validateDocument };