-- Indexes. Written as IF NOT EXISTS since primary-key/unique indexes
-- are already created automatically by the constraints in tables.sql.

CREATE UNIQUE INDEX IF NOT EXISTS age_pattern_signals_pkey ON public.age_pattern_signals USING btree (user_id);
CREATE INDEX IF NOT EXISTS age_pattern_signals_status_idx ON public.age_pattern_signals USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS agent_configs_pkey ON public.agent_configs USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_configs_user_id_agent_key ON public.agent_configs USING btree (user_id, agent);
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_pkey ON public.audit_logs USING btree (id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON public.audit_logs USING btree (event_type);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_pkey ON public.calendar_events USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_files_pkey ON public.conversation_files USING btree (id);
CREATE INDEX IF NOT EXISTS idx_conv_files_dossier_id ON public.conversation_files USING btree (dossier_id);
CREATE INDEX IF NOT EXISTS idx_conv_files_expires_at ON public.conversation_files USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_conv_files_user_id ON public.conversation_files USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_files_embedding ON public.conversation_files USING ivfflat (embedding vector_cosine_ops) WITH (lists='10');
CREATE UNIQUE INDEX IF NOT EXISTS dossiers_pkey ON public.dossiers USING btree (id);
CREATE INDEX IF NOT EXISTS idx_dossiers_user_id ON public.dossiers USING btree (user_id);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON public.feedback USING btree (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_pkey ON public.feedback USING btree (id);
CREATE INDEX IF NOT EXISTS feedback_status_idx ON public.feedback USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_ticket_no_key ON public.feedback USING btree (ticket_no);
CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON public.feedback USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS global_events_date_title_idx ON public.global_events USING btree (date, title);
CREATE UNIQUE INDEX IF NOT EXISTS global_events_pkey ON public.global_events USING btree (id);
CREATE INDEX IF NOT EXISTS global_events_tags_idx ON public.global_events USING gin (tags);
CREATE INDEX IF NOT EXISTS group_invites_group_id_idx ON public.group_invites USING btree (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS group_invites_invite_token_key ON public.group_invites USING btree (invite_token);
CREATE UNIQUE INDEX IF NOT EXISTS group_invites_pkey ON public.group_invites USING btree (id);
CREATE INDEX IF NOT EXISTS group_invites_target_user_idx ON public.group_invites USING btree (target_user_id) WHERE (target_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS group_invites_token_idx ON public.group_invites USING btree (invite_token) WHERE (invite_token IS NOT NULL);
CREATE INDEX IF NOT EXISTS group_members_group_id_idx ON public.group_members USING btree (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_id_user_id_key ON public.group_members USING btree (group_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS group_members_pkey ON public.group_members USING btree (id);
CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON public.group_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS group_messages_created_at_idx ON public.group_messages USING btree (group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS group_messages_group_id_idx ON public.group_messages USING btree (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS group_messages_pkey ON public.group_messages USING btree (id);
CREATE INDEX IF NOT EXISTS groups_owner_id_idx ON public.groups USING btree (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS groups_pkey ON public.groups USING btree (id);
CREATE INDEX IF NOT EXISTS groups_status_idx ON public.groups USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS guest_access_tokens_pkey ON public.guest_access_tokens USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_access_tokens_token_key ON public.guest_access_tokens USING btree (token);
CREATE INDEX IF NOT EXISTS kb_user_idx ON public.knowledge_base USING btree (user_id, agent_target);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_pkey ON public.knowledge_base USING btree (id);
CREATE INDEX IF NOT EXISTS knowledge_registry_domain_idx ON public.knowledge_registry USING btree (normalized_domain);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_registry_pkey ON public.knowledge_registry USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS memories_pkey ON public.memories USING btree (id);
CREATE INDEX IF NOT EXISTS memories_user_idx ON public.memories USING btree (user_id, agent_target, status);
CREATE INDEX IF NOT EXISTS idx_messages_dossier_id ON public.messages USING btree (dossier_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_pkey ON public.messages USING btree (id);
CREATE INDEX IF NOT EXISTS messages_user_idx ON public.messages USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON public.proposals USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON public.proposals USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_pkey ON public.proposals USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS quick_notes_pkey ON public.quick_notes USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS quick_notes_user_id_key ON public.quick_notes USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_safety_flags_created_at ON public.safety_flags USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_safety_flags_user_id ON public.safety_flags USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS safety_flags_pkey ON public.safety_flags USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_pkey ON public.tasks USING btree (id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON public.usage_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON public.usage_logs USING btree (model);
CREATE UNIQUE INDEX IF NOT EXISTS usage_logs_pkey ON public.usage_logs USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS user_news_sources_pkey ON public.user_news_sources USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_pkey ON public.user_profiles USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_short_id_idx ON public.user_profiles USING btree (short_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_short_id_key ON public.user_profiles USING btree (short_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_username_lower_idx ON public.user_profiles USING btree (lower(username));

-- group_message_reactions (Phase 8.7)
CREATE UNIQUE INDEX IF NOT EXISTS group_message_reactions_one_per_person_idx ON public.group_message_reactions USING btree (message_id, coalesce((sender_id)::text, sender_type));
CREATE INDEX IF NOT EXISTS group_message_reactions_group_id_idx ON public.group_message_reactions USING btree (group_id);

-- group_message_attachments (Phase 8.11)
create index if not exists idx_group_message_attachments_message_id on public.group_message_attachments(message_id);
create index if not exists idx_group_message_attachments_group_id   on public.group_message_attachments(group_id);

-- group_memories (Fase 11 item #2 — Group Memory) — reconstructed from
-- live schema introspection (10 Sep 2026), see 2_tables.sql's own
-- comment on this table for the full context of why this was missing.
CREATE INDEX IF NOT EXISTS group_memories_group_id_idx ON public.group_memories USING btree (group_id);
CREATE INDEX IF NOT EXISTS group_memories_status_idx ON public.group_memories USING btree (status);

-- trusted_devices (Fase 11 pre-demo security audit) — reconstructed from
-- live schema introspection (10 Sep 2026), see 2_tables.sql's own
-- comment on this table for the full context of why this was missing.
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_pkey ON public.trusted_devices USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_user_device_key ON public.trusted_devices USING btree (user_id, device_id);
CREATE INDEX IF NOT EXISTS trusted_devices_user_id_idx ON public.trusted_devices USING btree (user_id);
