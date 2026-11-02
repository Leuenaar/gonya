'use strict';
const PREFIX  = 'GNY';
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 

const generateShortIdCode = () => {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return `${PREFIX}-${code}`;
};

const generateUniqueShortId = async (supabase, maxAttempts = 5) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateShortIdCode();
    const { data, error } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('short_id', candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error('Could not generate a unique Short ID — please retry.');
};

const ensureShortId = async (supabase, userId) => {
  const { data: profile, error: fetchErr } = await supabase
    .from('user_profiles')
    .select('short_id')
    .eq('id', userId)
    .single();

  if (fetchErr) throw fetchErr;
  if (profile?.short_id) return profile.short_id;

  const shortId = await generateUniqueShortId(supabase);

  const { error: updateErr } = await supabase
    .from('user_profiles')
    .update({ short_id: shortId })
    .eq('id', userId);

  if (updateErr) throw updateErr;
  return shortId;
};

module.exports = { generateShortIdCode, generateUniqueShortId, ensureShortId };