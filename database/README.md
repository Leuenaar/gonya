# Database

The full Gonya schema for Supabase (Postgres), reconstructed from the live project and re-tested from an empty database. Roughly 28 tables, row-level security on all but one, and the Broadcast-from-Database triggers that power real-time chat.

## Set up a new project

Run the files in `schema/` in numeric order, in the Supabase SQL Editor:

```
1_extensions.sql   extensions
2_tables.sql       tables, primary keys, foreign keys, checks, unique constraints
3_indexes.sql      indexes (idempotent)
4_functions.sql    custom functions, including the broadcast functions
5_triggers.sql     auth signup triggers and broadcast triggers
6_policies.sql     row-level security and policies
```

Do not reorder them. `4_functions.sql` must run before `5_triggers.sql` (triggers call functions by name) and before `6_policies.sql` (some policies call security-definer helpers).

## Things to know before running

- **`supabase_vault`** is commented out in `1_extensions.sql` on purpose. Supabase manages it, and it does not exist on plain Postgres.
- **`knowledge_registry` has RLS off** on purpose. It matches the original project, where it is flagged "UNRESTRICTED" in the dashboard. Review this before using the schema for anything with real user data.
- **Auth triggers.** Two triggers on `auth.users` create the profile row: email signup gets role `guest`, OAuth signup gets role `member`.
- **Vector columns** are `vector(512)` and `vector(1536)`. Keep these dimensions if you stay on the same embedding model.
- **Vector indexes** use `ivfflat`, which only performs well once the table has data. On an empty project the index exists but similarity search will be slow until rows are added.
- **Row-level security** helpers such as `is_active_group_member()` avoid recursive policies. An earlier policy on `group_members` referenced itself and caused "infinite recursion detected"; it was replaced with the helper.

## Real-time design

Chat events are broadcast by Postgres triggers inside the same transaction as the write (`realtime.broadcast_changes()` from `SECURITY DEFINER` functions). Covered surfaces: personal messages, group messages, reactions, deletions and attachments. The reasoning is in the root README under Case study A.

## Verification

Applied in order from an empty Postgres 16 with pgvector, with zero errors on the final run.
