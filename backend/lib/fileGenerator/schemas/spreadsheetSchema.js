'use strict';
/**
 * UNIVERSAL SPREADSHEET SCHEMA
 *
 * A spreadsheet is one or more named sheets. Each sheet has typed
 * columns and rows of matching length. CSV rendering just uses the
 * first sheet (CSV has no concept of multiple sheets).
 *
 * Column types affect formatting in the renderer (e.g. 'currency'
 * gets a number format applied in exceljs), not just display.
 */

const COLUMN_TYPES = ['string', 'number', 'date', 'currency', 'percent'];

const validateSheet = (sheet, index) => {
  if (!sheet || typeof sheet !== 'object') {
    return { valid: false, error: `Sheet ${index}: not an object` };
  }
  if (typeof sheet.name !== 'string' || !sheet.name.trim()) {
    return { valid: false, error: `Sheet ${index}: name is required` };
  }
  if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
    return { valid: false, error: `Sheet ${index} ("${sheet.name}"): columns must be a non-empty array` };
  }

  for (const [ci, col] of sheet.columns.entries()) {
    if (typeof col.header !== 'string' || !col.header.trim()) {
      return { valid: false, error: `Sheet ${index}, column ${ci}: header is required` };
    }
    if (col.type && !COLUMN_TYPES.includes(col.type)) {
      return { valid: false, error: `Sheet ${index}, column ${ci}: invalid type "${col.type}"` };
    }
  }

  if (!Array.isArray(sheet.rows)) {
    return { valid: false, error: `Sheet ${index} ("${sheet.name}"): rows must be an array` };
  }
  for (const [ri, row] of sheet.rows.entries()) {
    if (!Array.isArray(row) || row.length !== sheet.columns.length) {
      return {
        valid: false,
        error: `Sheet ${index} ("${sheet.name}"), row ${ri}: length ${row?.length} does not match ${sheet.columns.length} columns`,
      };
    }
  }

  return { valid: true };
};

const validateSpreadsheet = (spreadsheet) => {
  const errors = [];

  if (!spreadsheet || typeof spreadsheet !== 'object') {
    return { valid: false, errors: ['Spreadsheet is not an object'] };
  }
  if (typeof spreadsheet.filename !== 'string' || !spreadsheet.filename.trim()) {
    errors.push('Spreadsheet filename is required');
  }
  if (!Array.isArray(spreadsheet.sheets) || spreadsheet.sheets.length === 0) {
    errors.push('Spreadsheet must have a non-empty sheets array');
  } else {
    spreadsheet.sheets.forEach((sheet, i) => {
      const result = validateSheet(sheet, i);
      if (!result.valid) errors.push(result.error);
    });
  }

  return { valid: errors.length === 0, errors };
};

module.exports = { COLUMN_TYPES, validateSheet, validateSpreadsheet };