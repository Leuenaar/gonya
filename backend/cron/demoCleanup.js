'use strict';
const { supabase } = require('../lib/supabase');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Deletes anonymous (demo) accounts older than 30 days. Deleting the
// auth.users row cascades to every table with a CASCADE foreign key —
// confirmed against this project's actual schema (9 Sep 2026):
// user_profiles, agent_configs, messages, memories, knowledge_base,
// dossiers, tasks, quick_notes, calendar_events, feedback,
// age_pattern_signals, groups, group_members, group_messages,
// trusted_devices, etc. all cascade automatically. usage_logs and
// guest_access_tokens deliberately use SET NULL instead — billing/
// analytics history stays intact, and an unclaimed token just becomes
// "unclaimed" again rather than vanishing. No manual per-table deletes
// needed; this only ever touches auth.users.
//
// is_anonymous is set by Supabase itself at signInAnonymously() time and
// is cleared automatically the moment a user links a real identity
// (email/OAuth) to upgrade from a demo session to a permanent account —
// confirmed from Supabase's own docs ("An anonymous user is considered a
// permanent user when they have an identity associated to them"). A
// visitor who liked the demo and converted their account is therefore
// never at risk of being swept up here, even after 30+ days.
const runDemoCleanup = async () => {
  console.log('[DemoCleanup] Starting daily scan for expired demo accounts...');
  try {
    let deletedCount = 0;
    let page = 1;
    const perPage = 200;

    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        console.error('[DemoCleanup] listUsers error:', error.message);
        break;
      }
      const users = data?.users || [];
      if (users.length === 0) break;

      for (const user of users) {
        if (!user.is_anonymous) continue;
        const ageMs = Date.now() - new Date(user.created_at).getTime();
        if (ageMs < THIRTY_DAYS_MS) continue;

        const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
        if (deleteError) {
          console.error(`[DemoCleanup] Failed to delete demo user ${user.id}:`, deleteError.message);
        } else {
          deletedCount++;
        }
      }

      if (users.length < perPage) break; // last page reached
      page++;
    }

    console.log(`[DemoCleanup] Scan complete. ${deletedCount} expired demo account(s) deleted.`);
  } catch (err) {
    console.error('[DemoCleanup] Scan failed:', err.message);
  }
};

module.exports = { runDemoCleanup };
