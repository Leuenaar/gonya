'use strict';
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const XLSX     = require('xlsx');

/**
 * Extract plain text from a file buffer based on its MIME type.
 * Returns empty string if the type is unsupported or extraction fails.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
const extractText = async (buffer, mimeType) => {
  try {
    if (mimeType === 'application/pdf') {
      const result = await pdfParse(buffer);
      return result.text?.trim() || '';
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value?.trim() || '';
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return workbook.SheetNames
        .map(name => XLSX.utils.sheet_to_txt(workbook.Sheets[name]))
        .join('\n')
        .trim();
    }

    if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      return buffer.toString('utf-8').trim();
    }

    // Images and other binary types — no text to extract
    return '';
  } catch (err) {
    console.warn('[Extractor] Failed to extract text:', err.message);
    return '';
  }
};

module.exports = { extractText };