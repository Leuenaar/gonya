'use strict';
const { supabase }  = require('./supabase');
const cloudinary    = require('cloudinary').v2;

cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});

const SUPABASE_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/json',
  'text/javascript',
  'text/typescript',
  'text/html',
  'text/css',
];

const CLOUDINARY_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

// ── Determine storage provider from file type ─────────────
const getProvider = (fileType) => {
  if (SUPABASE_TYPES.includes(fileType))    return 'supabase';
  if (CLOUDINARY_TYPES.includes(fileType))  return 'cloudinary';
  return 'supabase';
};

// ── Upload to Supabase Storage ────────────────────────────
const uploadToSupabase = async (userId, fileName, fileType, buffer) => {
  const storagePath = `${userId}/${Date.now()}_${fileName}`;
  const { error }   = await supabase.storage
    .from('triangle-files')
    .upload(storagePath, buffer, { contentType: fileType, upsert: false });

  if (error) throw error;
  return { storagePath, provider: 'supabase', expiresAt: null };
};

// ── Upload to Cloudinary (images, auto-expiry 7 days) ─────
const uploadToCloudinary = async (userId, fileName, fileType, buffer) => {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder:         `triangle/${userId}`,
        public_id:      `${Date.now()}_${fileName.replace(/\.[^/.]+$/, '')}`,
        resource_type:  'image',
        invalidate:     true,
      },
      (err, res) => err ? reject(err) : resolve(res)
    );
    stream.end(buffer);
  });

  return {
    storagePath: result.public_id,
    provider:    'cloudinary',
    url:         result.secure_url,
    expiresAt,
  };
};

// ── Main upload router ────────────────────────────────────
const uploadFile = async (userId, fileName, fileType, base64) => {
  const buffer   = Buffer.from(base64, 'base64');
  const provider = getProvider(fileType);

  if (provider === 'cloudinary') {
    return uploadToCloudinary(userId, fileName, fileType, buffer);
  }
  return uploadToSupabase(userId, fileName, fileType, buffer);
};

// ── Get signed/direct URL for a file ─────────────────────
// `fileName` (optional, 24 Aug 2026) triggers an actual browser
// download instead of an inline preview/open — passed through to
// Supabase's own `download` option on createSignedUrl(), which makes
// SUPABASE'S response carry the Content-Disposition: attachment header
// (not something we could add ourselves via a 302 redirect, since a
// redirect's own headers never apply to whatever the browser ends up
// actually fetching afterward). Cloudinary's equivalent is the
// `flags: 'attachment'` transformation. Backward compatible — omitting
// fileName keeps the old inline-preview behavior for any existing caller.
const getFileUrl = async (storagePath, provider, fileName) => {
  if (provider === 'cloudinary') {
    return cloudinary.url(storagePath, {
      secure: true,
      ...(fileName ? { flags: 'attachment' } : {}),
    });
  }
  const { data } = await supabase.storage
    .from('triangle-files')
    .createSignedUrl(storagePath, 3600, fileName ? { download: fileName } : undefined);
  return data?.signedUrl || null;
};

// ── Delete a file from its provider ──────────────────────
const deleteFile = async (storagePath, provider) => {
  if (provider === 'cloudinary') {
    await cloudinary.uploader.destroy(storagePath);
    return;
  }
  await supabase.storage.from('triangle-files').remove([storagePath]);
};

// ── Auto-expiry: delete Cloudinary files older than 7 days 
const purgeExpiredFiles = async () => {
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from('conversation_files')
    .select('id, storage_path, storage_provider')
    .eq('storage_provider', 'cloudinary')
    .lte('expires_at', now);

  if (!expired?.length) return;

  for (const file of expired) {
    try {
      await deleteFile(file.storage_path, file.storage_provider);
      await supabase.from('conversation_files').delete().eq('id', file.id);
    } catch (err) {
      console.warn('[Storage] Failed to purge file:', file.id, err.message);
    }
  }
  console.log(`[Storage] Purged ${expired.length} expired file(s)`);
};

module.exports = { uploadFile, getFileUrl, deleteFile, purgeExpiredFiles, getProvider };