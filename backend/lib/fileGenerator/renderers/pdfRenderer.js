'use strict';
/**
 * PDF RENDERER
 *
 * Converts a validated document (see schemas/documentSchema.js) into a
 * real .pdf file buffer, using pdfkit — a low-level drawing API, so
 * unlike docxRenderer this one manages its own layout/positioning
 * (pdfkit doesn't have a concept of "flowing" tables the way docx does).
 *
 * npm install pdfkit
 */
const PDFDocument = require('pdfkit');
const { validateDocument } = require('../schemas/documentSchema');

const MARGIN     = 50;
const PAGE_WIDTH = 595.28; // A4 in points

const FONT_SIZES = { 1: 22, 2: 17, 3: 14, 4: 12 };

/**
 * Draw a single block at the document's current cursor position.
 * pdfkit tracks its own Y position internally via doc.y, so blocks
 * are drawn in sequence and the library handles page overflow/adding
 * new pages automatically for text — but NOT for tables, which we
 * handle manually below.
 */
const drawBlock = (doc, block) => {
  switch (block.type) {
    case 'heading':
      doc.font('Helvetica-Bold')
        .fontSize(FONT_SIZES[block.level] || 14)
        .fillColor('#0a0a0a')
        .text(block.text, { paragraphGap: 8 });
      doc.moveDown(0.3);
      break;

    case 'paragraph':
      doc.font(block.emphasis === 'bold' ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(11)
        .fillColor('#1a1a1a')
        .text(block.text, {
          paragraphGap: 6,
          lineGap:      2,
          italics:      block.emphasis === 'italic',
        });
      doc.moveDown(0.4);
      break;

    case 'list':
      doc.font('Helvetica').fontSize(11).fillColor('#1a1a1a');
      block.items.forEach((item, i) => {
        const prefix = block.ordered ? `${i + 1}.` : '•';
        doc.text(`${prefix}  ${item}`, { indent: 14, paragraphGap: 3 });
      });
      doc.moveDown(0.4);
      break;

    case 'table': {
      // ── Fix (24 Aug 2026) ──────────────────────────────────────────────
      // The old version used a FIXED rowHeight (22pt) for every row,
      // regardless of how much text a cell actually contained. pdfkit's
      // .text() wraps long content onto multiple lines within the given
      // `width`, but never reports back how tall that wrapped text
      // actually ended up — so a cell like "Conduct skills audit and
      // capability assessment" (common in this document's real-world
      // output) would wrap to 2-3 lines and spill straight into the
      // fixed-height slot reserved for the NEXT row, since that next
      // row's background rectangle and text started at the same fixed
      // y-increment regardless. This is exactly what produced the
      // garbled, overlapping-looking table output that was reported.
      //
      // Fix: measure each cell's actual wrapped height first via
      // doc.heightOfString() (which DOES account for width-based
      // wrapping), and use the TALLEST cell in a row as that row's real
      // height — nothing overflows into the next row regardless of how
      // long any single cell's text is.
      const colCount    = block.headers.length;
      const tableWidth  = PAGE_WIDTH - MARGIN * 2;
      const colWidth    = tableWidth / colCount;
      const cellPadding = 6;
      const startX      = MARGIN;
      let y             = doc.y;

      const rowHeightFor = (font, fontSize, cells) => {
        doc.font(font).fontSize(fontSize);
        const heights = cells.map(c => doc.heightOfString(String(c), { width: colWidth - cellPadding * 2 }));
        return Math.max(...heights, fontSize + 6) + cellPadding * 2; // floor so a row is never absurdly thin even for empty/short cells
      };

      // Header row
      const headerHeight = rowHeightFor('Helvetica-Bold', 10, block.headers);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
      doc.rect(startX, y, tableWidth, headerHeight).fill('#0a0a0a');
      block.headers.forEach((h, i) => {
        doc.fillColor('#ffffff').text(h, startX + i * colWidth + cellPadding, y + cellPadding, { width: colWidth - cellPadding * 2 });
      });
      y += headerHeight;

      // Data rows
      block.rows.forEach((row, ri) => {
        const rh = rowHeightFor('Helvetica', 10, row);

        // Page overflow check — pdfkit doesn't auto-paginate manual drawing
        if (y + rh > doc.page.height - MARGIN) {
          doc.addPage();
          y = MARGIN;
        }

        doc.font('Helvetica').fontSize(10);
        const bg = ri % 2 === 0 ? '#f5f5f5' : '#ffffff';
        doc.rect(startX, y, tableWidth, rh).fill(bg);
        row.forEach((cell, ci) => {
          doc.fillColor('#1a1a1a').text(String(cell), startX + ci * colWidth + cellPadding, y + cellPadding, { width: colWidth - cellPadding * 2 });
        });
        y += rh;
      });

      doc.x = MARGIN;   // reset — explicit per-cell x-coordinates above never returned pdfkit's own cursor to the left margin
      doc.y = y + 10;   // move cursor below the table for subsequent blocks
      break;
    }

    case 'quote':
      doc.font('Helvetica-Oblique')
        .fontSize(11)
        .fillColor('#4a4a4a')
        .text(block.text, { indent: 20, paragraphGap: 8 });
      doc.moveDown(0.4);
      break;

    case 'pageBreak':
      doc.addPage();
      break;

    case 'spacer':
      doc.moveDown(0.8);
      break;
  }
};

/**
 * Render a validated document object into a .pdf Buffer.
 */
const renderPdf = (doc) =>
  new Promise((resolve, reject) => {
    const { valid, errors } = validateDocument(doc);
    if (!valid) return reject(new Error(`Invalid document: ${errors.join('; ')}`));

    const pdf    = new PDFDocument({ margin: MARGIN, size: 'A4' });
    const chunks = [];

    pdf.on('data',  chunk => chunks.push(chunk));
    pdf.on('end',   ()    => resolve(Buffer.concat(chunks)));
    pdf.on('error', err   => reject(err));

    // Title
    pdf.font('Helvetica-Bold').fontSize(24).fillColor('#0a0a0a').text(doc.title, { paragraphGap: 6 });
    if (doc.subtitle) {
      pdf.font('Helvetica-Oblique').fontSize(12).fillColor('#5d6b7d').text(doc.subtitle, { paragraphGap: 16 });
    }
    pdf.moveDown(0.5);

    for (const block of doc.blocks) {
      drawBlock(pdf, block);
    }

    pdf.end();
  });

module.exports = { renderPdf };