-- All public tables, reconstructed from live schema introspection.
-- Run AFTER extensions.sql, BEFORE functions.sql/triggers.sql/policies.sql.
-- Foreign keys are added at the end (after every table exists) to avoid
-- ordering issues, including cross-schema refs into auth.users.

create table public.age_pattern_signals (
  user_id uuid not null,
  minor_confidence integer not null default 0,
  check_count integer not null default 0,
  status text not null default 'clear'::text,
  last_category text,
  evidence_log jsonb not null default '[]'::jsonb,
  admin_reviewed_at timestamptz,
  admin_verdict text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.age_pattern_signals add constraint age_pattern_signals_pkey PRIMARY KEY (user_id);
alter table public.age_pattern_signals add constraint age_pattern_signals_admin_verdict_check CHECK ((admin_verdict = ANY (ARRAY['adult_confirmed'::text, 'resolved_minor'::text, NULL::text])));
alter table public.age_pattern_signals add constraint age_pattern_signals_minor_confidence_check CHECK (((minor_confidence >= '-100'::integer) AND (minor_confidence <= 100)));
alter table public.age_pattern_signals add constraint age_pattern_signals_status_check CHECK ((status = ANY (ARRAY['clear'::text, 'monitoring'::text, 'flagged'::text, 'adult_confirmed'::text, 'inconclusive'::text])));

create table public.agent_configs (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  agent text not null,
  domain text,
  persona_prompt text,
  is_dominant boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_configs add constraint agent_configs_pkey PRIMARY KEY (id);
alter table public.agent_configs add constraint agent_configs_user_id_agent_key UNIQUE (user_id, agent);
alter table public.agent_configs add constraint agent_configs_agent_check CHECK ((agent = ANY (ARRAY['Aksel'::text, 'Vera'::text])));

create table public.audit_logs (
  id uuid not null default gen_random_uuid(),
  event_type text not null,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs add constraint audit_logs_pkey PRIMARY KEY (id);

create table public.calendar_events (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  date date not null,
  time text,
  color text not null default 'cyan'::text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_events add constraint calendar_events_pkey PRIMARY KEY (id);

create table public.conversation_files (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  conversation_id text,
  file_name text not null,
  file_type text not null,
  storage_provider text not null,
  storage_path text not null,
  size_bytes bigint default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  extracted_text text,
  embedding vector(512),
  dossier_id uuid
);

alter table public.conversation_files add constraint conversation_files_pkey PRIMARY KEY (id);
alter table public.conversation_files add constraint conversation_files_storage_provider_check CHECK ((storage_provider = ANY (ARRAY['supabase'::text, 'r2'::text, 'cloudinary'::text])));

create table public.dossiers (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  color text default '#00e5ff'::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dossiers add constraint dossiers_pkey PRIMARY KEY (id);

create table public.feedback (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  ticket_no text not null,
  type text not null,
  subject text,
  transcript jsonb not null,
  status text not null default 'new'::text,
  created_at timestamptz not null default now()
);

alter table public.feedback add constraint feedback_pkey PRIMARY KEY (id);
alter table public.feedback add constraint feedback_ticket_no_key UNIQUE (ticket_no);
alter table public.feedback add constraint feedback_status_check CHECK ((status = ANY (ARRAY['new'::text, 'reviewed'::text, 'resolved'::text])));
alter table public.feedback add constraint feedback_type_check CHECK ((type = ANY (ARRAY['feedback'::text, 'support'::text])));

create table public.global_events (
  id uuid not null default gen_random_uuid(),
  title text not null,
  date date not null,
  summary text not null,
  category text not null default 'general'::text,
  source_url text,
  created_at timestamptz not null default now(),
  tags text[] default '{}'::text[]
);

alter table public.global_events add constraint global_events_pkey PRIMARY KEY (id);

create table public.group_invites (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  invited_by uuid not null,
  invite_type text not null,
  target_user_id uuid,
  invite_token text,
  expires_at timestamptz,
  used_by uuid,
  used_at timestamptz,
  status text not null default 'pending'::text,
  created_at timestamptz not null default now()
);

alter table public.group_invites add constraint group_invites_pkey PRIMARY KEY (id);
alter table public.group_invites add constraint group_invites_invite_token_key UNIQUE (invite_token);
alter table public.group_invites add constraint group_invites_invite_type_check CHECK ((invite_type = ANY (ARRAY['short_id'::text, 'link'::text])));
alter table public.group_invites add constraint group_invites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'revoked'::text])));

create table public.group_members (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  user_id uuid not null,
  role text not null default 'member'::text,
  status text not null default 'active'::text,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.group_members add constraint group_members_pkey PRIMARY KEY (id);
alter table public.group_members add constraint group_members_group_id_user_id_key UNIQUE (group_id, user_id);
alter table public.group_members add constraint group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'co_admin'::text, 'member'::text])));
alter table public.group_members add constraint group_members_status_check CHECK ((status = ANY (ARRAY['active'::text, 'kicked'::text, 'left'::text])));

create table public.group_messages (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  sender_id uuid,
  sender_type text not null,
  sender_name text,
  content text not null,
  reply_to uuid,
  created_at timestamptz not null default now()
);

alter table public.group_messages add constraint group_messages_pkey PRIMARY KEY (id);
alter table public.group_messages add constraint group_messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'aksel'::text, 'vera'::text])));

create table public.groups (
  id uuid not null default gen_random_uuid(),
  name text not null,
  purpose text,
  milestones jsonb not null default '[]'::jsonb,
  agent_config jsonb not null default '{}'::jsonb,
  owner_id uuid not null,
  status text not null default 'active'::text,
  max_members integer not null default 6,
  onboarding_done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.groups add constraint groups_pkey PRIMARY KEY (id);
alter table public.groups add constraint groups_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'dissolved'::text])));

create table public.guest_access_tokens (
  id uuid not null default gen_random_uuid(),
  token text not null,
  personal_onboard_used boolean default false,
  group_onboard_used boolean default false,
  chat_quota integer default 20,
  assigned_user_id uuid,
  created_at timestamptz default now()
);

alter table public.guest_access_tokens add constraint guest_access_tokens_pkey PRIMARY KEY (id);
alter table public.guest_access_tokens add constraint guest_access_tokens_token_key UNIQUE (token);
alter table public.guest_access_tokens add constraint guest_access_tokens_chat_quota_check CHECK ((chat_quota >= 0));

create table public.knowledge_base (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  agent_target text not null,
  category text not null,
  content text not null,
  source text not null default 'manual'::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.knowledge_base add constraint knowledge_base_pkey PRIMARY KEY (id);
alter table public.knowledge_base add constraint knowledge_base_agent_target_check CHECK ((agent_target = ANY (ARRAY['Aksel'::text, 'Vera'::text, 'Both'::text])));
alter table public.knowledge_base add constraint knowledge_base_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'theones'::text, 'registry'::text])));

create table public.knowledge_registry (
  id uuid not null default gen_random_uuid(),
  domain text not null,
  normalized_domain text not null,
  category text,
  aksel_knowledge text,
  vera_knowledge text,
  embedding vector(1536),
  hit_count integer not null default 0,
  last_accessed timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.knowledge_registry add constraint knowledge_registry_pkey PRIMARY KEY (id);

create table public.memories (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  agent_target text not null,
  layer integer not null,
  category text not null,
  content text not null,
  status text not null default 'pending'::text,
  confidence integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.memories add constraint memories_pkey PRIMARY KEY (id);
alter table public.memories add constraint memories_agent_target_check CHECK ((agent_target = ANY (ARRAY['Aksel'::text, 'Vera'::text, 'Both'::text])));
alter table public.memories add constraint memories_confidence_check CHECK (((confidence >= 1) AND (confidence <= 3)));
alter table public.memories add constraint memories_layer_check CHECK ((layer = ANY (ARRAY[1, 2, 3])));
alter table public.memories add constraint memories_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));

create table public.messages (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  sender text not null,
  content text not null,
  created_at timestamptz not null default now(),
  dossier_id uuid,
  -- voice_transcript (add_voice_transcript_column.sql): full turn-by-turn
  -- transcript for a voice-call summary row — [{"speaker":"User"/agent,
  -- "text":"..."}]. NULL for ordinary text messages.
  voice_transcript jsonb,
  -- sources (add_sources_column.sql): web-search citations a text-chat
  -- reply used — [{"index":1,"title":"...","snippet":"...","url":"..."}].
  -- NULL for a reply that didn't search.
  sources jsonb
);

alter table public.messages add constraint messages_pkey PRIMARY KEY (id);
alter table public.messages add constraint messages_sender_check CHECK ((sender = ANY (ARRAY['User'::text, 'Aksel'::text, 'Vera'::text, 'System'::text])));

create table public.proposals (
  id uuid not null default gen_random_uuid(),
  quarter text not null,
  status text not null default 'pending'::text,
  safety_conduct jsonb,
  api_news jsonb,
  bug_function jsonb,
  user_feedback jsonb,
  theones_summary text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.proposals add constraint proposals_pkey PRIMARY KEY (id);
alter table public.proposals add constraint proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'partially_approved'::text, 'approved'::text, 'rejected'::text])));

create table public.quick_notes (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  content text not null default ''::text,
  updated_at timestamptz not null default now()
);

alter table public.quick_notes add constraint quick_notes_pkey PRIMARY KEY (id);
alter table public.quick_notes add constraint quick_notes_user_id_key UNIQUE (user_id);

create table public.safety_flags (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  agent text not null,
  risk_tier text not null,
  category text not null,
  theones_verdict text,
  created_at timestamptz not null default now()
);

alter table public.safety_flags add constraint safety_flags_pkey PRIMARY KEY (id);
alter table public.safety_flags add constraint safety_flags_agent_check CHECK ((agent = ANY (ARRAY['Aksel'::text, 'Vera'::text])));
alter table public.safety_flags add constraint safety_flags_category_check CHECK ((category = ANY (ARRAY['crisis'::text, 'dependency'::text, 'romantic_pressure'::text, 'reality_distortion'::text, 'adversarial'::text])));
alter table public.safety_flags add constraint safety_flags_risk_tier_check CHECK ((risk_tier = ANY (ARRAY['needs_review'::text, 'high'::text])));
alter table public.safety_flags add constraint safety_flags_theones_verdict_check CHECK ((theones_verdict = ANY (ARRAY['confirmed'::text, 'false_alarm'::text, 'pending'::text])));

create table public.tasks (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  content text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks add constraint tasks_pkey PRIMARY KEY (id);

create table public.usage_logs (
  id uuid not null default gen_random_uuid(),
  model text not null,
  call_type text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  user_id uuid,
  created_at timestamptz not null default now()
);

alter table public.usage_logs add constraint usage_logs_pkey PRIMARY KEY (id);

create table public.user_news_sources (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  url text not null,
  category text not null default 'Custom'::text,
  created_at timestamptz default now()
);

alter table public.user_news_sources add constraint user_news_sources_pkey PRIMARY KEY (id);

create table public.user_profiles (
  id uuid not null,
  display_name text,
  role text not null default 'guest'::text,
  gender text,
  language_style text,
  radar_categories text[] not null default '{}'::text[],
  onboarding_complete boolean not null default false,
  onboarding_step integer not null default 0,
  is_active boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Default 'en' (fix_default_language_en.sql) — was 'id' originally,
  -- which caused a real onboarding bug (fresh signups defaulting to
  -- Indonesian even when the user picked English on the sign-up form,
  -- before that toggle was wired through). handle_new_user()/
  -- handle_new_oauth_user() in functions.sql read the actual chosen
  -- language and only fall back to this default when it's genuinely
  -- absent, so this default and their fallback intentionally agree.
  language text not null default 'en'::text,
  date_of_birth date,
  short_id text,
  username text,
  -- onboarding_state (add_onboarding_state.sql, 29 Aug 2026): full
  -- checkpoint snapshot of in-progress onboarding (age/gender/langStyle/
  -- domain/questions/answers/radar selections + the sticky
  -- onboardSucceeded flag) — lets OnboardingShell.tsx resume from the
  -- last completed step after a refresh instead of restarting, and
  -- critically prevents re-triggering the expensive TheOnes/Opus call
  -- on reload once it has already succeeded once. NULL until the first
  -- checkpoint is saved.
  onboarding_state jsonb
);

alter table public.user_profiles add constraint user_profiles_pkey PRIMARY KEY (id);
alter table public.user_profiles add constraint user_profiles_short_id_key UNIQUE (short_id);
alter table public.user_profiles add constraint user_profiles_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text])));
alter table public.user_profiles add constraint user_profiles_language_check CHECK ((language = ANY (ARRAY['id'::text, 'en'::text])));
alter table public.user_profiles add constraint user_profiles_language_style_check CHECK ((language_style = ANY (ARRAY['casual'::text, 'formal'::text])));
alter table public.user_profiles add constraint user_profiles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'guest'::text])));
alter table public.user_profiles add constraint user_profiles_username_format CHECK (((username IS NULL) OR (username ~ '^[a-z0-9_]{3,20}$'::text)));

-- Foreign keys (added last, after all tables + PKs exist)
alter table public.age_pattern_signals add constraint age_pattern_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.agent_configs add constraint agent_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.calendar_events add constraint calendar_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.conversation_files add constraint conversation_files_dossier_id_fkey FOREIGN KEY (dossier_id) REFERENCES dossiers(id) ON DELETE SET NULL;
alter table public.conversation_files add constraint conversation_files_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public.dossiers add constraint dossiers_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public.feedback add constraint feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.group_invites add constraint group_invites_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
alter table public.group_invites add constraint group_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.group_invites add constraint group_invites_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.group_invites add constraint group_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);
alter table public.group_members add constraint group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
alter table public.group_members add constraint group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.group_messages add constraint group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
alter table public.group_messages add constraint group_messages_reply_to_fkey FOREIGN KEY (reply_to) REFERENCES group_messages(id) ON DELETE SET NULL;
alter table public.group_messages add constraint group_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.groups add constraint groups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.guest_access_tokens add constraint guest_access_tokens_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.knowledge_base add constraint knowledge_base_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.memories add constraint memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.messages add constraint messages_dossier_id_fkey FOREIGN KEY (dossier_id) REFERENCES dossiers(id) ON DELETE SET NULL;
alter table public.messages add constraint messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.quick_notes add constraint quick_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.safety_flags add constraint safety_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public.tasks add constraint tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.usage_logs add constraint usage_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE SET NULL;
alter table public.user_news_sources add constraint user_news_sources_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public.user_profiles add constraint user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- group_message_reactions (Phase 8.7 — Group Chat Portfolio v1, item 3)
create table public.group_message_reactions (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  message_id  uuid not null references public.group_messages(id) on delete cascade,
  sender_id   uuid,
  sender_type text not null default 'user',
  sender_name text,
  emoji       text not null,
  created_at  timestamptz not null default now(),

  constraint group_message_reactions_emoji_check
    check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  constraint group_message_reactions_sender_type_check
    check (sender_type in ('user', 'aksel', 'vera'))
);

-- group_messages: message deletion support (Phase 8.9 — Group Chat Portfolio v1, item 5)
alter table public.group_messages add column if not exists deleted_at timestamptz;

-- group_message_attachments (Phase 8.11 — Group Chat Portfolio v1, item 7)
-- TANPA expires_at, sengaja — media histori group chat permanen (beda dari
-- conversation_files personal chat, which is temporary by design).
create table public.group_message_attachments (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references public.groups(id) on delete cascade,
  message_id        uuid not null references public.group_messages(id) on delete cascade,
  uploaded_by       uuid not null,
  file_name         text not null,
  file_type         text not null,
  storage_provider  text not null check (storage_provider in ('supabase', 'cloudinary')),
  storage_path      text not null,
  size_bytes        bigint not null default 0,
  created_at        timestamptz not null default now()
);

-- group_memories (Fase 11 item #2 — Group Memory, 22 Aug 2026)
-- Reconstructed from live schema introspection (10 Sep 2026) — this
-- table existed live but was MISSING from this file entirely until now
-- (found during a schema-drift audit). At the time of that audit, the
-- table had NO primary key, no foreign keys, and no indexes at all —
-- fixed live first (confirmed no orphaned rows existed beforehand),
-- reflected here to match. Unlike the personal memories table, this has
-- no CHECK constraints on layer/status/agent_target live — worth adding
-- to match memories' stricter shape, but treated as a separate decision
-- rather than silently introduced while documenting current reality.
create table public.group_memories (
  id           uuid not null default gen_random_uuid(),
  group_id     uuid not null,
  content      text not null,
  layer        integer not null default 1,
  category     text,
  status       text not null default 'pending'::text,
  agent_target text not null default 'Both'::text,
  approved_by  uuid,
  created_at   timestamptz not null default now()
);

alter table public.group_memories add constraint group_memories_pkey PRIMARY KEY (id);
alter table public.group_memories add constraint group_memories_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
alter table public.group_memories add constraint group_memories_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- trusted_devices (Fase 11 pre-demo security audit, 23 Aug 2026)
-- Reconstructed from live schema introspection (10 Sep 2026) — same gap
-- as group_memories above: existed live, was never captured in this
-- file. RLS is enabled with ZERO policies, confirmed intentional — this
-- table is only ever touched via the backend's service-role key
-- (middleware/auth.js's device-trust gate), never directly from the
-- frontend, so no client-facing policy is needed at all.
create table public.trusted_devices (
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null,
  device_id    text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.trusted_devices add constraint trusted_devices_pkey PRIMARY KEY (id);
alter table public.trusted_devices add constraint trusted_devices_user_device_key UNIQUE (user_id, device_id);
alter table public.trusted_devices add constraint trusted_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
