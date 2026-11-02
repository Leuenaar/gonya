-- Row Level Security: enable per table, then all policies.
-- Run AFTER tables.sql and functions.sql (policies call helper functions).

alter table public.age_pattern_signals enable row level security;
alter table public.agent_configs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.calendar_events enable row level security;
alter table public.conversation_files enable row level security;
alter table public.dossiers enable row level security;
alter table public.feedback enable row level security;
alter table public.global_events enable row level security;
alter table public.group_invites enable row level security;
alter table public.group_members enable row level security;
alter table public.group_memories enable row level security;
alter table public.group_messages enable row level security;
alter table public.groups enable row level security;
alter table public.guest_access_tokens enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.memories enable row level security;
alter table public.messages enable row level security;
alter table public.proposals enable row level security;
alter table public.quick_notes enable row level security;
alter table public.safety_flags enable row level security;
alter table public.tasks enable row level security;
alter table public.trusted_devices enable row level security;
alter table public.usage_logs enable row level security;
alter table public.user_news_sources enable row level security;
alter table public.user_profiles enable row level security;

-- agent_configs: configs_own
create policy "configs_own" on public.agent_configs
  for ALL
  using ((auth.uid() = user_id));

-- calendar_events: Users can manage their own events
create policy "Users can manage their own events" on public.calendar_events
  for ALL
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- dossiers: Users manage own dossiers
create policy "Users manage own dossiers" on public.dossiers
  for ALL
  to authenticated
  using ((user_id = auth.uid()));

-- feedback: Users can insert their own feedback
create policy "Users can insert their own feedback" on public.feedback
  for INSERT
  with check ((auth.uid() = user_id));

-- feedback: Users can insert their own tickets
create policy "Users can insert their own tickets" on public.feedback
  for INSERT
  with check ((auth.uid() = user_id));

-- feedback: Users can read their own tickets
create policy "Users can read their own tickets" on public.feedback
  for SELECT
  using ((auth.uid() = user_id));

-- feedback: Users can view their own feedback
create policy "Users can view their own feedback" on public.feedback
  for SELECT
  using ((auth.uid() = user_id));

-- global_events: Anyone can read global events
create policy "Anyone can read global events" on public.global_events
  for SELECT
  using (true);

-- group_invites: Invitees can read their pending invites
create policy "Invitees can read their pending invites" on public.group_invites
  for SELECT
  using (((target_user_id = auth.uid()) AND (status = 'pending'::text)));

-- group_members: Members can read group membership
create policy "Members can read group membership" on public.group_members
  for SELECT
  using ((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_members.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));

-- group_messages: Members can read group messages
create policy "Members can read group messages" on public.group_messages
  for SELECT
  using ((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_messages.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));

-- groups: Members can read their groups
create policy "Members can read their groups" on public.groups
  for SELECT
  using ((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = groups.id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));

-- guest_access_tokens: Admin full access
create policy "Admin full access" on public.guest_access_tokens
  for ALL
  using ((EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'admin'::text)))));

-- guest_access_tokens: Guest read own token
create policy "Guest read own token" on public.guest_access_tokens
  for SELECT
  using ((assigned_user_id = auth.uid()));

-- knowledge_base: kb_own
create policy "kb_own" on public.knowledge_base
  for ALL
  using ((auth.uid() = user_id));

-- memories: memories_own
create policy "memories_own" on public.memories
  for ALL
  using ((auth.uid() = user_id));

-- messages: messages_own
create policy "messages_own" on public.messages
  for ALL
  using ((auth.uid() = user_id));

-- quick_notes: Users can manage their own notes
create policy "Users can manage their own notes" on public.quick_notes
  for ALL
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- tasks: Users can manage their own tasks
create policy "Users can manage their own tasks" on public.tasks
  for ALL
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- user_news_sources: user_news_sources_own
create policy "user_news_sources_own" on public.user_news_sources
  for ALL
  using ((auth.uid() = user_id));

-- user_profiles: Admins can read all
create policy "Admins can read all" on public.user_profiles
  for SELECT
  using (check_is_admin_or_owner());

-- user_profiles: Admins can update all
create policy "Admins can update all" on public.user_profiles
  for UPDATE
  using (check_is_admin_or_owner());

-- user_profiles: Users can read own profile
create policy "Users can read own profile" on public.user_profiles
  for SELECT
  using ((auth.uid() = id));

-- user_profiles: Users can update own profile
create policy "Users can update own profile" on public.user_profiles
  for UPDATE
  using ((auth.uid() = id));

-- user_profiles: profiles_own
create policy "profiles_own" on public.user_profiles
  for ALL
  using ((auth.uid() = id));


-- group_message_reactions (Phase 8.7)
alter table public.group_message_reactions enable row level security;
grant select on public.group_message_reactions to authenticated;

create policy "group members can read reactions" on public.group_message_reactions
  for select
  to authenticated
  using (public.is_active_group_member(group_id));

-- realtime.messages: personal chat channel authorization (Phase 8.8)
create policy "user can receive their own personal broadcasts" on realtime.messages
  for select
  to authenticated
  using (
    (select realtime.topic()) like 'personal:%'
    and split_part((select realtime.topic()), ':', 2) = (select auth.uid())::text
  );

-- group_members: FIX infinite recursion (Phase 8.10) — the policy above
-- (block near the top of this file) is the ORIGINAL broken version,
-- reconstructed as-is from the live database for historical accuracy.
-- This replaces it with the fixed version when the file is run top to
-- bottom — reuses the same is_active_group_member() helper already used
-- by group_messages/group_message_reactions/realtime.messages.
drop policy if exists "Members can read group membership" on public.group_members;
create policy "Members can read group membership" on public.group_members
  for select
  to authenticated
  using (public.is_active_group_member(group_id));

-- group_message_attachments: read access (Phase 8.11)
alter table public.group_message_attachments enable row level security;
grant select on public.group_message_attachments to authenticated;

create policy "Members can read group attachments" on public.group_message_attachments
  for select
  to authenticated
  using (public.is_active_group_member(group_id));

-- group_memories (Fase 11 item #2 — Group Memory) — reconstructed from
-- live schema introspection (10 Sep 2026), missing from this file
-- entirely despite existing live. Read-only from the client on purpose —
-- approving/rejecting a pending memory goes through a backend route
-- using the service-role key, never directly from the frontend, so no
-- INSERT/UPDATE policy exists or is needed here.
create policy "Members can read approved group memories" on public.group_memories
  for select
  using (((status = 'approved'::text) AND is_active_group_member(group_id)));

create policy "Owner and co-admin can read all group memories" on public.group_memories
  for select
  using (is_group_owner_or_admin(group_id));

-- trusted_devices (Fase 11 pre-demo security audit) — reconstructed from
-- live schema introspection (10 Sep 2026). RLS is enabled (see the
-- alter table statement near the top of this file) but DELIBERATELY has
-- zero policies — this table is only ever touched via the backend's
-- service-role key (middleware/auth.js's device-trust gate), which
-- bypasses RLS entirely, so no client-facing policy is needed.
