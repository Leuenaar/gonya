-- All custom functions (public + auth schema). Run BEFORE triggers.sql
-- (triggers reference these by name) and BEFORE policies.sql (some
-- policies call these as security-definer helpers).

-- auth.email
CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

-- auth.jwt
CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

-- auth.role
CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

-- auth.uid
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

-- public.broadcast_group_message
CREATE OR REPLACE FUNCTION public.broadcast_group_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform realtime.broadcast_changes(
    'group:' || new.group_id::text,  -- topic: matches the channel name the frontend subscribes to
    'INSERT',                        -- event name the client listens for
    'INSERT',                        -- operation
    tg_table_name,
    tg_table_schema,
    new,                             -- full new row -> delivered as payload.record
    null                             -- no old row on INSERT
  );
  return null;
exception when others then
  -- Never let a delivery failure break message persistence.
  raise warning 'broadcast_group_message failed for message % (group %): %',
    new.id, new.group_id, sqlerrm;
  return null;
end;
$function$;

-- public.check_is_admin_or_owner
CREATE OR REPLACE FUNCTION public.check_is_admin_or_owner()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  user_role text;
BEGIN
  SELECT role INTO user_role FROM public.user_profiles WHERE id = auth.uid();
  RETURN user_role IN ('admin', 'owner');
END;
$function$;

-- public.generate_short_id
CREATE OR REPLACE FUNCTION public.generate_short_id()
 RETURNS text
 LANGUAGE sql
AS $function$
  select 'GNY-' || (
    select string_agg(
      substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (floor(random() * 32) + 1)::int, 1),
      ''
    )
    from generate_series(1, 6)
  );
$function$;

-- public.generate_username
CREATE OR REPLACE FUNCTION public.generate_username(p_display_name text, p_attempt integer DEFAULT 0)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  v_reserved constant text[] := array[
    'aksel','vera','theones','thea','theo',
    'admin','owner','support','gonya','system','root','null','undefined','api'
  ];
  v_base text;
  v_candidate text;
  v_suffix_len int;
  v_suffix text := '';
begin
  v_base := lower(unaccent(coalesce(p_display_name, '')));
  v_base := regexp_replace(v_base, '[^a-z0-9_]', '', 'g');
  if length(v_base) > 20 then
    v_base := left(v_base, 20);
  end if;
  while length(v_base) < 3 loop
    v_base := v_base || floor(random() * 10)::int::text;
  end loop;

  if p_attempt = 0 and not (v_base = any(v_reserved)) then
    return v_base;
  end if;

  v_suffix_len := least(2 + p_attempt, 6);
  for i in 1..v_suffix_len loop
    v_suffix := v_suffix || floor(random() * 10)::int::text;
  end loop;
  v_candidate := left(v_base, 20 - v_suffix_len) || v_suffix;

  if v_candidate = any(v_reserved) then
    return public.generate_username(p_display_name, p_attempt + 1);
  end if;

  return v_candidate;
end;
$function$;

-- public.handle_new_oauth_user
CREATE OR REPLACE FUNCTION public.handle_new_oauth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_display_name text;
  v_username     text;
  v_short_id     text;
  v_language     text;
  v_attempt      int := 0;
begin
  if not exists (select 1 from public.user_profiles where id = new.id) then
    v_display_name := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
    -- OAuth providers (Google) don't carry Gonya's own signup-form fields
    -- in raw_user_meta_data, so this coalesce will almost always fall
    -- through to 'en' here in practice — kept for symmetry with
    -- handle_new_user() and in case that ever changes, and because the
    -- `language` column's own DEFAULT is 'en' regardless (see
    -- fix_default_language_en.sql), so this is redundant-but-harmless.
    v_language := coalesce(new.raw_user_meta_data->>'language', 'en');

    loop
      v_username := public.generate_username(v_display_name, v_attempt);
      v_short_id := public.generate_short_id();
      begin
        insert into public.user_profiles (
          id, display_name, role, is_active, onboarding_complete, onboarding_step, radar_categories, username, short_id, language
        ) values (
          new.id, v_display_name, 'member', true, false, 0, '{}', v_username, v_short_id, v_language
        );
        exit;
      exception when unique_violation then
        v_attempt := v_attempt + 1;
        if v_attempt >= 8 then
          raise exception 'Could not assign a unique username/short_id for user % after 8 attempts', new.id;
        end if;
      end;
    end loop;
  end if;
  return new;
end;
$function$;

-- public.handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_display_name text;
  v_username     text;
  v_short_id     text;
  v_language     text;
  v_attempt      int := 0;
begin
  v_display_name := coalesce(
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'display_name',
    new.email
  );
  -- Reads the Interface Language toggle from AuthScreen.tsx's sign-up form
  -- (passed through signUp()'s options.data.language in lib/supabase.ts).
  -- Falls back to 'en' if absent — same default as the column itself
  -- (see fix_default_language_en.sql), so an unrecognized/missing value
  -- never regresses back to defaulting Indonesian.
  v_language := coalesce(new.raw_user_meta_data->>'language', 'en');

  loop
    v_username := public.generate_username(v_display_name, v_attempt);
    v_short_id := public.generate_short_id();
    begin
      insert into public.user_profiles (id, display_name, role, username, short_id, language)
      values (new.id, v_display_name, 'guest', v_username, v_short_id, v_language)
      on conflict (id) do nothing;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 8 then
        raise exception 'Could not assign a unique username/short_id for user % after 8 attempts', new.id;
      end if;
    end;
  end loop;

  return new;
end;
$function$;

-- public.is_active_group_member
CREATE OR REPLACE FUNCTION public.is_active_group_member(gid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = gid
      and gm.user_id = auth.uid()
      and gm.status = 'active'
  );
$function$;

-- public.is_group_owner_or_admin — reconstructed from live schema
-- introspection (10 Sep 2026), was missing from this file entirely
-- despite existing live and backing group_memories' "Owner and co-admin
-- can read all" policy (6_policies.sql). Same shape as
-- is_active_group_member above, narrowed to owner/co_admin roles only.
CREATE OR REPLACE FUNCTION public.is_group_owner_or_admin(gid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = gid
      and gm.user_id = auth.uid()
      and gm.status = 'active'
      and gm.role in ('owner', 'co_admin')
  );
$function$;

-- public.purge_old_safety_flags
CREATE OR REPLACE FUNCTION public.purge_old_safety_flags()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM safety_flags
  WHERE created_at < now() - INTERVAL '30 days'
    AND theones_verdict IN ('confirmed', 'false_alarm');
END;
$function$;

-- public.search_files_by_embedding
CREATE OR REPLACE FUNCTION public.search_files_by_embedding(p_user_id uuid, p_embedding vector, p_limit integer DEFAULT 3)
 RETURNS TABLE(id uuid, file_name text, file_type text, extracted_text text, storage_path text, storage_provider text, similarity double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    id, file_name, file_type, extracted_text,
    storage_path, storage_provider,
    1 - (embedding <=> p_embedding) AS similarity
  FROM conversation_files
  WHERE user_id = p_user_id
    AND embedding IS NOT NULL
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$function$;


-- public.broadcast_group_event (Phase 8.6 — sempat ketinggalan, sekarang ditambahin)
create or replace function public.broadcast_group_event(
  p_group_id uuid,
  p_event    text,
  p_payload  jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform realtime.send(
    p_payload,
    p_event,
    'group:' || p_group_id::text,
    true
  );
exception when others then
  raise warning 'broadcast_group_event failed for group % event %: %', p_group_id, p_event, sqlerrm;
end;
$function$;

grant execute on function public.broadcast_group_event(uuid, text, jsonb) to authenticated, service_role;

-- public.broadcast_group_reaction (Phase 8.7)
create or replace function public.broadcast_group_reaction()
returns trigger
security definer
set search_path = ''
language plpgsql
as $function$
declare
  target_group_id uuid;
  event_name      text;
begin
  if tg_op = 'DELETE' then
    target_group_id := old.group_id;
    event_name      := 'reaction_removed';
  else
    target_group_id := new.group_id;
    event_name      := 'reaction_added';
  end if;

  perform realtime.broadcast_changes(
    'group:' || target_group_id::text,
    event_name,
    tg_op,
    tg_table_name,
    tg_table_schema,
    case when tg_op != 'DELETE' then new end,
    case when tg_op = 'DELETE' then old end
  );
  return null;
exception when others then
  raise warning 'broadcast_group_reaction failed for group % (%): %',
    target_group_id, event_name, sqlerrm;
  return null;
end;
$function$;

-- public.broadcast_personal_message (Phase 8.8 — Roadmap Step A, personal chat Realtime)
create or replace function public.broadcast_personal_message()
returns trigger
security definer
set search_path = ''
language plpgsql
as $function$
begin
  perform realtime.broadcast_changes(
    'personal:' || new.user_id::text,
    'INSERT',
    'INSERT',
    tg_table_name,
    tg_table_schema,
    new,
    null
  );
  return null;
exception when others then
  raise warning 'broadcast_personal_message failed for user % message %: %',
    new.user_id, new.id, sqlerrm;
  return null;
end;
$function$;

-- public.broadcast_group_message_deleted (Phase 8.9)
create or replace function public.broadcast_group_message_deleted()
returns trigger
security definer
set search_path = ''
language plpgsql
as $function$
begin
  perform realtime.broadcast_changes(
    'group:' || new.group_id::text,
    'message_deleted',
    'UPDATE',
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
exception when others then
  raise warning 'broadcast_group_message_deleted failed for group % message %: %',
    new.group_id, new.id, sqlerrm;
  return null;
end;
$function$;

-- public.broadcast_group_attachment (Phase 8.11)
create or replace function public.broadcast_group_attachment()
returns trigger
security definer
set search_path = ''
language plpgsql
as $function$
begin
  perform realtime.broadcast_changes(
    'group:' || new.group_id::text,
    'attachment_added',
    'INSERT',
    tg_table_name,
    tg_table_schema,
    new,
    null
  );
  return null;
exception when others then
  raise warning 'broadcast_group_attachment failed for group % attachment %: %',
    new.group_id, new.id, sqlerrm;
  return null;
end;
$function$;
