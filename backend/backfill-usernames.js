'use strict';
// One-off script: assigns a username to every existing account that
// doesn't have one yet (created before Phase 8.5's eager assignment).
// New signups no longer need this — the trigger handles them at creation.
//
// Run once from backend/:  node backfill-usernames.js
const { supabase } = require('./lib/supabase');
const { assignUsernameToExisting } = require('./lib/username');

async function main() {
  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id, display_name, username')
    .is('username', null);

  if (error) throw error;

  console.log(`Found ${profiles.length} profile(s) without a username.\n`);

  let ok = 0, failed = 0;
  for (const p of profiles) {
    try {
      const username = await assignUsernameToExisting(supabase, p.id, p.display_name);
      console.log(`  OK    ${p.display_name} (${p.id}) -> @${username}`);
      ok++;
    } catch (err) {
      console.error(`  FAIL  ${p.display_name} (${p.id}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} assigned, ${failed} failed.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Backfill script crashed:', err); process.exit(1); });
