'use strict';
const express  = require('express');
const router   = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { uploadFile, getFileUrl, deleteFile, purgeExpiredFiles } = require('../lib/storage');
const { extractText }               = require('../lib/extractor');
const { embed, embedQuery, vectorToString } = require('../lib/embeddings');

// ── GET /api/files?conversation_id=xxx ───────────────────
router.get('/', verifyToken, async (req, res) => {
  const { conversation_id } = req.query;
  try {
    let query = supabase
      .from('conversation_files')
      .select('id, file_name, file_type, storage_provider, storage_path, size_bytes, expires_at, created_at, conversation_id')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (conversation_id) query = query.eq('conversation_id', conversation_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/files/upload ────────────────────────────────
router.post('/upload', verifyToken, async (req, res) => {
  const { file_name, file_type, file_base64, conversation_id } = req.body;
  if (!file_name || !file_type || !file_base64) {
    return res.status(400).json({ status: 'error', message: 'file_name, file_type, file_base64 required' });
  }

  try {
    const buffer = Buffer.from(file_base64, 'base64');

    // Upload to storage (Supabase or Cloudinary based on type)
    const uploadResult = await uploadFile(req.userId, file_name, file_type, file_base64);

    // Extract text and generate embedding in background (non-blocking)
    let extractedText = '';
    let embeddingStr  = null;

    try {
      extractedText = await extractText(buffer, file_type);
      if (extractedText) {
        const vector = await embed(extractedText);
        if (vector) embeddingStr = vectorToString(vector);
      }
    } catch (embErr) {
      console.warn('[Files] Extraction/embedding failed (non-fatal):', embErr.message);
    }

    // Bug fixed (10 Sep 2026): confirmed via real testing — a PDF/Word/
    // Excel upload that fails to yield any extracted text (e.g. a
    // scanned/image-only PDF with no real text layer — pdf-parse has no
    // OCR capability) was silently reported as a successful upload, with
    // NOTHING telling the user their file's contents are invisible to
    // Aksel/Vera. The agent later had to guess or admit it "couldn't
    // open" the file, confusing about a limitation the person had no way
    // to know about at upload time. This flags it back to the frontend
    // right away for types that are EXPECTED to contain readable text —
    // images/other binary types correctly returning '' isn't a failure,
    // so those are deliberately excluded here.
    const DOCUMENT_TYPES = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    const noTextExtracted = DOCUMENT_TYPES.includes(file_type) && !extractedText;

    const { data: record, error: dbErr } = await supabase
      .from('conversation_files')
      .insert({
        user_id:          req.userId,
        conversation_id:  conversation_id || null,
        file_name,
        file_type,
        storage_provider: uploadResult.provider,
        storage_path:     uploadResult.storagePath,
        size_bytes:       buffer.length,
        expires_at:       uploadResult.expiresAt || null,
        extracted_text:   extractedText || null,
        embedding:        embeddingStr  || null,
      })
      .select('id, file_name, file_type, storage_provider, storage_path, size_bytes, expires_at, created_at, conversation_id')
      .single();

    if (dbErr) throw dbErr;

    res.json({
      status: 'success',
      data:   { ...record, url: uploadResult.url || null, noTextExtracted },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/files/search?q=query&limit=3 ────────────────
// Used by chat handler to find relevant files before generating a response
router.get('/search', verifyToken, async (req, res) => {
  const { q, limit = 3 } = req.query;
  if (!q) return res.status(400).json({ status: 'error', message: 'q required' });

  try {
    const queryVector = await embedQuery(q);

    if (!queryVector) {
      // Fallback to full-text search if Voyage AI unavailable
      const { data, error } = await supabase
        .from('conversation_files')
        .select('id, file_name, file_type, extracted_text, storage_path, storage_provider')
        .eq('user_id', req.userId)
        .not('extracted_text', 'is', null)
        .ilike('extracted_text', `%${q}%`)
        .limit(parseInt(limit));
      if (error) throw error;
      return res.json({ status: 'success', data: data || [], method: 'fulltext' });
    }

    // Semantic search via pgvector
    const vectorStr = vectorToString(queryVector);
    const { data, error } = await supabase.rpc('search_files_by_embedding', {
      p_user_id:   req.userId,
      p_embedding: vectorStr,
      p_limit:     parseInt(limit),
    });

    if (error) throw error;
    res.json({ status: 'success', data: data || [], method: 'semantic' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/files/:id/url ────────────────────────────────
router.get('/:id/url', verifyToken, async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from('conversation_files')
      .select('storage_path, storage_provider, file_name, expires_at')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (error || !file) return res.status(404).json({ status: 'error', message: 'File not found' });
    if (file.expires_at && new Date(file.expires_at) < new Date()) {
      return res.status(410).json({ status: 'error', message: 'File has expired' });
    }
    const url = await getFileUrl(file.storage_path, file.storage_provider);
    res.json({ status: 'success', url, expires_at: file.expires_at });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/files/:id/download ───────────────────────────
// Short, stable redirect link used in chat file-delivery messages
// (24 Aug 2026) instead of embedding the raw signed Supabase URL
// directly — that URL carries a long JWT token as a query param and
// made every file-delivery message an unreadable wall of text.
//
// Deliberately NOT behind verifyToken: this link is meant to be clicked
// directly from a chat message in the browser (a normal page
// navigation, not an authenticated fetch() call from the app), so
// there's no Authorization header to check. This doesn't weaken the
// actual security model — the RAW signed URL it replaces was ALREADY
// the entire access mechanism (anyone holding that long URL could
// already open the file with zero further auth), so this is the same
// possession-based model with a short, unguessable UUID standing in
// for the same thing, not a new hole.
router.get('/:id/download', async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from('conversation_files')
      .select('storage_path, storage_provider, file_name, expires_at')
      .eq('id', req.params.id)
      .single();

    if (error || !file) {
      return res.status(404).send('File not found.');
    }
    if (file.expires_at && new Date(file.expires_at) < new Date()) {
      return res.status(410).send('This file link has expired.');
    }

    // Passing file_name (24 Aug 2026) makes the destination Supabase/
    // Cloudinary response itself carry a download-triggering header, so
    // clicking this link saves the file directly instead of opening an
    // inline preview.
    const url = await getFileUrl(file.storage_path, file.storage_provider, file.file_name);
    res.redirect(302, url);
  } catch (err) {
    console.error('[Files] Download redirect error:', err.message);
    res.status(500).send('Something went wrong fetching that file.');
  }
});

// ── DELETE /api/files/:id ─────────────────────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from('conversation_files')
      .select('storage_path, storage_provider')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();
    if (error || !file) return res.status(404).json({ status: 'error', message: 'File not found' });
    await deleteFile(file.storage_path, file.storage_provider);
    await supabase.from('conversation_files').delete().eq('id', req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/files/purge ─────────────────────────────────
router.post('/purge', verifyToken, async (req, res) => {
  try {
    await purgeExpiredFiles();
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;