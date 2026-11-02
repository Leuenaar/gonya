'use strict';
/**
 * XLSX RENDERER
 *
 * Converts a validated spreadsheet (see schemas/spreadsheetSchema.js)
 * into a real .xlsx file buffer, using exceljs — chosen over the
 * simpler 'xlsx' (SheetJS) package because exceljs supports proper
 * cell type formatting (currency, percent, date) and styling, which
 * the schema's column 'type' field is designed to drive.
 *
 * npm install exceljs
 */
const ExcelJS = require('exceljs');
const { validateSpreadsheet } = require('../schemas/spreadsheetSchema');

const NUMBER_FORMATS = {
  string:   undefined,
  number:   '#,##0.00',
  date:     'yyyy-mm-dd',
  currency: '$#,##0.00',
  percent:  '0.00%',
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

/**
 * Render a validated spreadsheet object into a .xlsx Buffer.
 */
const renderXlsx = async (spreadsheet) => {
  const { valid, errors } = validateSpreadsheet(spreadsheet);
  if (!valid) throw new Error(`Invalid spreadsheet: ${errors.join('; ')}`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gonya';
  workbook.created = new Date();

  for (const sheetDef of spreadsheet.sheets) {
    const sheet = workbook.addWorksheet(sheetDef.name.slice(0, 31)); // Excel sheet name limit

    sheet.columns = sheetDef.columns.map(col => ({
      header: col.header,
      key:    col.header,
      width:  col.width || Math.max(12, col.header.length + 4),
    }));

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.eachCell(cell => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { vertical: 'middle' };
    });
    headerRow.height = 20;

    // Add data rows
    sheetDef.rows.forEach(row => {
      const rowValues = {};
      sheetDef.columns.forEach((col, i) => { rowValues[col.header] = row[i]; });
      sheet.addRow(rowValues);
    });

    // Apply per-column number formatting based on schema type
    sheetDef.columns.forEach((col, i) => {
      const format = NUMBER_FORMATS[col.type];
      if (!format) return;
      const excelCol = sheet.getColumn(i + 1);
      excelCol.numFmt = format;
    });

    // Freeze header row for usability on large sheets
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return workbook.xlsx.writeBuffer();
};

module.exports = { renderXlsx };