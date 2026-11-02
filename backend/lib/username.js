'use strict';

// Names that must never be claimable as a username — Aksel/Vera/TheOnes/
// Thea/Theo are real chat participants; letting a user register as one of
// them would be impersonation-adjacent inside a group chat. System/brand
// words are blocked for the usual reasons (support scams, confusion).
const RESERVED = new Set([
  'aksel', 'vera', 'theones', 'thea', 'theo',
  'admin', 'owner', 'support', 'gonya', 'system', 'root', 'null', 'undefined', 'api',
]);

const MIN_LEN  = 3;
const MAX_LEN  = 20;
const VALID_RE = /^[a-z0-9_]{3,20}$/;

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// Turns a free-form display_name into a valid base slug. Does not guarantee
// uniqueness or dodge reserved words on its own — generateUsernameCandidate
// handles that on top of this.
function slugify(displayName) {
  let base = (displayName || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents (café -> cafe)
    .replace(/[^a-z0-9_]/g, '');

  if (base.length > MAX_LEN) base = base.slice(0, MAX_LEN);
  while (base.length < MIN_LEN) base += randomDigits(1); // e.g. emoji-only or 1-char display name
  return base;
}

// attempt 0 = bare slug. Each subsequent attempt appends more random digits
// (growing suffix length), so repeated collisions become exponentially less
// likely rather than retrying the exact same candidate forever.
function generateUsernameCandidate(displayName, attempt = 0) {
  const base = slugify(displayName);
  if (attempt === 0 && !RESERVED.has(base)) return base;

  const suffixLen    = Math.min(2 + attempt, 6);
  const trimmedBase  = base.slice(0, MAX_LEN - suffixLen);
  const candidate    = `${trimmedBase}${randomDigits(suffixLen)}`;
  if (RESERVED.has(candidate)) return generateUsernameCandidate(displayName, attempt + 1);
  return candidate;
}

const isUniqueViolation = (error) => error?.code === '23505';

// Assigns a username to an EXISTING profile row that doesn't have one yet
// (the backfill path for accounts created before this feature existed).
// Uses update-then-retry-on-real-unique-violation rather than check-then-
// write, so two concurrent runs (or a backfill racing a live signup) can't
// both pass a pre-check and then collide anyway.
async function assignUsernameToExisting(supabase, userId, displayName, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateUsernameCandidate(displayName, attempt);
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ username: candidate })
      .eq('id', userId)
      .is('username', null) // never clobber an already-assigned username
      .select('username')
      .single();

    if (!error) return data.username;
    if (!isUniqueViolation(error)) throw error; // a different failure — don't mask it by retrying
  }
  throw new Error(`Could not assign a unique username for user ${userId} after ${maxAttempts} attempts.`);
}

module.exports = {
  RESERVED, VALID_RE, MIN_LEN, MAX_LEN,
  slugify, generateUsernameCandidate, isUniqueViolation, assignUsernameToExisting,
};