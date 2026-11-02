'use strict';

// Note: the original phase notes gave "TRI-A8K3F2" as the example format,
// but that predates the full rebrand (see: triangle_* → gonya_* localStorage
// keys cleaned up elsewhere). Using GNY- here to match current branding —
// flag if you'd rather keep TRI- for continuity with old references.

const PREFIX = 'GNY';

// Excludes visually ambiguous characters (I, O, 0, 1) so ticket numbers are
// easy to read aloud or retype without mixups.
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateTicketCode = () => {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return `${PREFIX}-${code}`;
};

// Generates a ticket number and confirms it isn't already taken, retrying
// a few times on the (very unlikely) chance of a collision.
const generateUniqueTicketNo = async (supabase, maxAttempts = 5) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateTicketCode();
    const { data, error } = await supabase
      .from('feedback')
      .select('id')
      .eq('ticket_no', candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error('Could not generate a unique ticket number, please retry.');
};

module.exports = { generateTicketCode, generateUniqueTicketNo };
