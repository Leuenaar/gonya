'use strict';
/**
 * DOCX RENDERER
 *
 * Converts a validated document (see schemas/documentSchema.js) into a
 * real .docx file buffer, using the 'docx' npm package (pure JS, no
 * Word/LibreOffice dependency needed on the server).
 *
 * npm install docx
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType,
  PageBreak, AlignmentType,
} = require('docx');

const { validateDocument } = require('../schemas/documentSchema');

const HEADING_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

/**
 * Convert a single schema block into one or more docx elements
 * (Paragraph / Table). Returns an array since a block always maps to
 * at least one docx node, sometimes more isn't needed but keeping it
 * as an array keeps the reducer below simple.
 */
const renderBlock = (block) => {
  switch (block.type) {
    case 'heading':
      return [new Paragraph({
        text:    block.text,
        heading: HEADING_MAP[block.level] || HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
      })];

    case 'paragraph': {
      const run = new TextRun({
        text:   block.text,
        bold:   block.emphasis === 'bold',
        italics: block.emphasis === 'italic',
      });
      return [new Paragraph({ children: [run], spacing: { after: 160 } })];
    }

    case 'list':
      return block.items.map((item, i) => new Paragraph({
        text: block.ordered ? `${i + 1}. ${item}` : item,
        bullet: block.ordered ? undefined : { level: 0 },
        spacing: { after: 80 },
        indent: { left: 360 },
      }));

    case 'table': {
      const headerRow = new TableRow({
        children: block.headers.map(h => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
          width:    { size: 100 / block.headers.length, type: WidthType.PERCENTAGE },
        })),
      });
      const dataRows = block.rows.map(row => new TableRow({
        children: row.map(cell => new TableCell({
          children: [new Paragraph({ text: String(cell) })],
        })),
      }));
      return [new Table({ rows: [headerRow, ...dataRows], width: { size: 100, type: WidthType.PERCENTAGE } })];
    }

    case 'quote':
      return [new Paragraph({
        children: [new TextRun({ text: block.text, italics: true })],
        indent:   { left: 480 },
        spacing:  { after: 160 },
        border:   { left: { color: '00E5FF', space: 8, style: 'single', size: 12 } },
      })];

    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })];

    case 'spacer':
      return [new Paragraph({ text: '', spacing: { after: 160 } })];

    default:
      return [];
  }
};

/**
 * Render a validated document object into a .docx Buffer.
 * Throws if the document fails schema validation — callers should
 * validate first if they want a cleaner error path, but this is a
 * safety net either way.
 */
const renderDocx = async (doc) => {
  const { valid, errors } = validateDocument(doc);
  if (!valid) throw new Error(`Invalid document: ${errors.join('; ')}`);

  const children = [
    new Paragraph({
      text:    doc.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
    }),
  ];

  if (doc.subtitle) {
    children.push(new Paragraph({
      children: [new TextRun({ text: doc.subtitle, italics: true, color: '5D6B7D' })],
      spacing:  { after: 300 },
    }));
  }

  for (const block of doc.blocks) {
    children.push(...renderBlock(block));
  }

  const docxDoc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(docxDoc);
};

module.exports = { renderDocx };