'use strict';
/**
 * FILE GENERATION ORCHESTRATOR
 *
 * The single entry point the rest of Gonya talks to. Ties together:
 *   1. Marker detection  — find [[GENERATE_FILE: format | title | description]]
 *                          in an agent's response text
 *   2. Architect          — expand the marker into a full structure
 *   3. Render             — turn that structure into real file bytes
 *   4. Upload + record    — storage.js handles Supabase/Cloudinary
 *                          routing, then we log it in conversation_files
 *                          so it shows up in Vault/exports like any
 *                          other file.
 */
const { runArchitect }  = require('./architect');
const { renderDocx }    = require('./renderers/docxRenderer');
const { renderPdf }     = require('./renderers/pdfRenderer');
const { renderXlsx }    = require('./renderers/xlsxRenderer');
const { renderCode }    = require('./renderers/codeRenderer');
const { uploadFile, getFileUrl } = require('../storage');
const { supabase }      = require('../supabase');

// Matches: [[GENERATE_FILE: xlsx | Q3 Budget | A breakdown of spending]]
// Pipe-delimited — agents are instructed (in the system prompt update)
// never to use literal "|" inside the title/description.
const MARKER_REGEX = /\[\[GENERATE_FILE:\s*([a-zA-Z0-9]+)\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\s*\]\]/g;

const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf:  'application/pdf',
  csv:  'text/csv',
  js:   'text/javascript',
  ts:   'text/typescript',
  jsx:  'text/javascript',
  tsx:  'text/typescript',
  css:  'text/css',
  html: 'text/html',
  json: 'application/json',
  // No dedicated entry in storage.js's SUPABASE_TYPES for these — that's
  // fine, its getProvider() defaults unmatched types to 'supabase' anyway.
  md:   'text/plain',
  py:   'text/plain',
  yaml: 'text/plain',
  yml:  'text/plain',
  sql:  'text/plain',
  sh:   'text/plain',
  txt:  'text/plain',
};

/**
 * Detect file-generation markers in agent text. Returns an array of
 * { format, title, description, raw }. `raw` is the exact matched
 * text so callers can strip it from what's actually displayed to the
 * user (nobody should see the raw marker syntax in chat).
 */
const detectFileMarkers = (text) => {
  const markers = [];
  MARKER_REGEX.lastIndex = 0; // this function is synchronous end-to-end, so
                              // resetting here is sufficient — see index.test notes
  let match;
  while ((match = MARKER_REGEX.exec(text)) !== null) {
    markers.push({
      format:      match[1].toLowerCase(),
      title:       match[2].trim(),
      description: match[3].trim(),
      raw:         match[0],
    });
  }
  return markers;
};

/** Strip all file-generation markers out of text, leaving clean prose.
 *  Also collapses the double-space/blank-line artifact left behind
 *  where a marker used to sit. */
const stripFileMarkers = (text) =>
  text.replace(MARKER_REGEX, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Replace each file-generation marker with a markdown hyperlink to the
 * finished file (24 Aug 2026 — synchronous single-response redesign).
 * `resolvedFiles` is a Map from the marker's `raw` text to its
 * generated { fileName, url }, built by the caller after awaiting
 * generateFile() for each marker. A marker with no entry in the map
 * (generation failed) is replaced with a short apologetic note instead
 * of silently vanishing.
 */
const replaceFileMarkersWithLinks = (text, resolvedFiles) => {
  MARKER_REGEX.lastIndex = 0;
  return text.replace(MARKER_REGEX, (raw) => {
    const resolved = resolvedFiles.get(raw);
    if (!resolved) return "_(Sorry, I couldn't generate that file — mind asking again?)_";
    return `[${resolved.fileName}](${resolved.url})`;
  }).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
};

// ── Markdown conversion (document category, format === 'md') ───────────────
// No dedicated renderer file for markdown — it's plain text, so this
// converts the same document schema straight to .md syntax and hands
// it to codeRenderer for the trivial Buffer wrap.
const documentToMarkdown = (doc) => {
  const lines = [`# ${doc.title}`];
  if (doc.subtitle) lines.push(`*${doc.subtitle}*`);
  lines.push('');

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(`${'#'.repeat(block.level)} ${block.text}`, '');
        break;
      case 'paragraph': {
        let t = block.text;
        if (block.emphasis === 'bold')   t = `**${t}**`;
        if (block.emphasis === 'italic') t = `*${t}*`;
        lines.push(t, '');
        break;
      }
      case 'list':
        block.items.forEach((item, i) => {
          lines.push(block.ordered ? `${i + 1}. ${item}` : `- ${item}`);
        });
        lines.push('');
        break;
      case 'table':
        lines.push(`| ${block.headers.join(' | ')} |`);
        lines.push(`| ${block.headers.map(() => '---').join(' | ')} |`);
        block.rows.forEach(row => lines.push(`| ${row.join(' | ')} |`));
        lines.push('');
        break;
      case 'quote':
        lines.push(`> ${block.text}`, '');
        break;
      case 'pageBreak':
        lines.push('---', '');
        break;
      case 'spacer':
        lines.push('');
        break;
    }
  }
  return lines.join('\n');
};

/** Dispatch to the renderer that matches the requested format. */
const renderByFormat = async (format, data) => {
  if (format === 'docx') return renderDocx(data);
  if (format === 'pdf')  return renderPdf(data);
  if (format === 'md')   return renderCode('md', documentToMarkdown(data));
  if (format === 'xlsx') return renderXlsx(data);
  if (format === 'csv')  return renderCode('csv', data);
  return renderCode(format, data.content); // code category
};

/** Build a clean, URL-safe filename from the architect's own filename
 *  field (spreadsheet/code categories) or the requested title (document
 *  category, which has no filename field of its own). */
const filenameFor = (format, title, data) => {
  const source = data.filename || title || 'file';
  const withoutExt = source.toString().trim().replace(/\.[a-zA-Z0-9]+$/, ''); // strip any extension the architect may have already included
  const base = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'file';
  return `${base}.${format}`;
};

// Short, stable redirect link (24 Aug 2026 — ".env kerapihan"/UX cleanup)
// instead of the raw signed Supabase URL, which carries a very long JWT
// token as a query param and made every file-delivery message an
// unreadable wall of text. Points at routes/files.js's new
// GET /api/files/:fileId/download, which looks up this SAME fileId and
// redirects (302) to the real signed URL — the actual signing/expiry
// logic doesn't change at all, this just hides it behind a clean link.
const BASE_URL = process.env.BACKEND_URL || process.env.FRONTEND_URL || '';
const shortUrlFor = (fileId) => `${BASE_URL}/api/files/${fileId}/download`;

/**
 * Full pipeline for one detected marker: architect → render → upload
 * → record in conversation_files. Returns { fileName, url, format, fileId }.
 * `url` is now the SHORT redirect link, not the raw signed URL.
 */
const generateFile = async ({ userId, format, title, description, context }) => {
  const { data } = await runArchitect({ format, title, description, context, userId });

  const buffer   = await renderByFormat(format, data);
  const fileName = filenameFor(format, title, data);
  const mimeType = MIME_TYPES[format] || 'text/plain';

  const uploadResult = await uploadFile(userId, fileName, mimeType, buffer.toString('base64'));

  const { data: fileRow, error } = await supabase
    .from('conversation_files')
    .insert({
      user_id:          userId,
      file_name:        fileName,
      file_type:        mimeType,
      size_bytes:       buffer.length,
      storage_path:     uploadResult.storagePath,
      storage_provider: uploadResult.provider,
      expires_at:       uploadResult.expiresAt,
    })
    .select()
    .single();

  if (error) throw error;

  return { fileName, url: shortUrlFor(fileRow.id), format, fileId: fileRow.id };
};

module.exports = { detectFileMarkers, stripFileMarkers, replaceFileMarkersWithLinks, generateFile, documentToMarkdown, MARKER_REGEX };
