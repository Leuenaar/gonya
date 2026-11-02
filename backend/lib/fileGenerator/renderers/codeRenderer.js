'use strict';
/**
 * CODE / PLAIN-TEXT RENDERER
 *
 * For formats that don't need a binary structure — .js, .py, .css,
 * .json, .md, .txt, .csv, .yaml, etc. No external library needed:
 * the "render" step is just validating there's actual content and
 * wrapping it in a Buffer.
 *
 * CSV gets a light touch here too — if the caller passes a
 * spreadsheet-shaped object instead of a raw string (from the same
 * Document Architect flow used for xlsx), it's converted to
 * comma-separated rows. This keeps CSV and XLSX sharing one data
 * model rather than needing two separate architect prompts.
 */

const ALLOWED_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'html', 'json',
  'md', 'txt', 'yaml', 'yml', 'sql', 'sh', 'csv',
];

/**
 * Escape a single CSV field per RFC 4180: wrap in quotes if it
 * contains a comma, quote, or newline; double up any internal quotes.
 */
const escapeCsvField = (value) => {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

/**
 * Convert a spreadsheet-shaped object (schemas/spreadsheetSchema.js,
 * first sheet only — CSV has no concept of multiple sheets) into a
 * CSV string.
 */
const spreadsheetToCsv = (spreadsheet) => {
  const sheet = spreadsheet.sheets?.[0];
  if (!sheet) throw new Error('No sheet data provided for CSV export');

  const headerLine = sheet.columns.map(c => escapeCsvField(c.header)).join(',');
  const dataLines   = sheet.rows.map(row => row.map(escapeCsvField).join(','));

  return [headerLine, ...dataLines].join('\r\n');
};

/**
 * Render plain text/code content into a Buffer.
 *
 * @param {string} extension - file extension without the dot (e.g. 'js', 'csv')
 * @param {string|object} content - raw text, OR a spreadsheet-shaped
 *   object if extension is 'csv' and the architect produced tabular data
 */
const renderCode = (extension, content) => {
  const ext = extension.toLowerCase().replace(/^\./, '');

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported plain-text extension: .${ext}`);
  }

  let text;
  if (ext === 'csv' && typeof content === 'object') {
    text = spreadsheetToCsv(content);
  } else {
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Content must be a non-empty string');
    }
    text = content;
  }

  return Buffer.from(text, 'utf-8');
};

module.exports = { renderCode, ALLOWED_EXTENSIONS, spreadsheetToCsv };