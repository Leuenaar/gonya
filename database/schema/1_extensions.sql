-- Extensions required by this project.
-- Run this FIRST, before tables.sql (types like `vector` depend on these).

create extension if not exists "pg_stat_statements";
create extension if not exists "pgcrypto";
create extension if not exists "plpgsql";
-- supabase_vault is a Supabase-platform-managed extension — it is
-- pre-installed on every Supabase project automatically and is NOT
-- available on a plain/local Postgres install. No action needed on
-- Supabase; omit this line entirely if restoring to a non-Supabase Postgres.
-- create extension if not exists "supabase_vault";
create extension if not exists "unaccent";
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
