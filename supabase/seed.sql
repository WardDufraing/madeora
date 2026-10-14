-- Deterministic synthetic seed (architecture.md §25). Applied after migrations by
-- `supabase db reset`, by `supabase start` on a fresh database, and by the local fallback.
--
-- Only made-up data: fixed IDs, fixed timestamps, and addresses on the reserved `.test` domain,
-- which can never receive mail. Never add real people, households or exported production data.
--
-- The users have no password and cannot sign in. They exist so RLS tests have stable actors.
-- Local development accounts are registered in the app and confirmed through the local mail
-- catcher (docs/development.md, "Accounts").

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'alice@madeora.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    '',
    '{"provider": "email", "providers": ["email"]}',
    '{}',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'bob@madeora.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    '',
    '{"provider": "email", "providers": ["email"]}',
    '{}',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'carol@madeora.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    '',
    '{"provider": "email", "providers": ["email"]}',
    '{}',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  );
