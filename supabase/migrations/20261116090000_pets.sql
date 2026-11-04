-- S31: pets (brief plans/steps/S31-brief.md; ADR 0041; Modules.md §4.6 "Confirmed pet profile scope and
-- optional fields", "Confirmed structured pet medical history", "Confirmed pet medical-information
-- access permissions"). Care schedules and the pet-care widget are in 20261117090000_pet_care.sql.
--
-- A pet belongs to exactly one Home; there are no personal pets. Nothing here is exposed as a table:
-- people use security-definer functions that run with their own session and recheck the confirmed
-- caller, their current membership and their access on every call. A Home the caller is not in answers
-- 42501 exactly like one that does not exist; a pet or medical entry they may not see answers
-- 'not_found' exactly like a missing one.
--
-- Two separate permissions (packages/domain/src/permissions/pets.ts makes the same decisions):
-- - Pets (basic profile): every current member sees the Home's pets and their basic profile. Pet
--   managers (the Owner and Administrators granted the new delegable capability manageHomePets) add,
--   edit, delete and restore pets.
-- - Medical information (sensitive profile details, medical history, its attachments): a per-member,
--   per-Home level, 'view' or 'manage', that nobody but the Owner has until it is granted. Pet access
--   never implies it. The Owner and Administrators granted managePetMedicalAccess grant and revoke it,
--   never their own. It is checked on every read, download authorization and write, so a change works
--   at once; it ends with the membership.
--
-- A person without medical view never receives a sensitive field, a medical entry, its count, type,
-- date or existence, an attachment's name or file, or a medical trash entry.

-- Audit subjects, the new capabilities, trash types, file purposes ------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series',
    'pet', 'pet_medical_entry', 'pet_medical_attachment'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals', 'manageHomeHabits', 'manageHomeGoals', 'manageHomePets',
    'managePetMedicalAccess'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals', 'habits',
    'goals', 'pets'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal',
    'goal_series', 'pet', 'pet_medical_entry', 'pet_medical_attachment'
  ));

alter table private.stored_files drop constraint stored_files_purpose_check;
alter table private.stored_files add constraint stored_files_purpose_check
  check (purpose in ('avatar', 'task_attachment', 'recipe_cover', 'pet_photo', 'pet_medical_attachment'));

-- Limits and value rules ---------------------------------------------------------------------------------

-- apps/web/src/pets/schema.ts uses the same numbers.
create function private.pet_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'pets' then 50                 -- pets per Home that are not in the trash
    when 'entries' then 1000            -- medical entries per pet that are not in the trash
    when 'attachments' then 10          -- attachments per medical entry, uploads in progress included
    when 'name' then 80
    when 'short' then 120               -- breed, species label, veterinarian, clinic, entry title
    when 'location' then 200
    when 'address' then 300
    when 'long' then 2000               -- diet, care instructions, notes, allergies, medications
    when 'identifier' then 64           -- microchip, registration or passport number
    when 'identification_notes' then 500
    when 'phone' then 40
    when 'email' then 254
    when 'attachment_name' then 200
  end;
  $$;

-- One line of plain text (names, labels, numbers): no line breaks or tabs. Null for null (so a
-- column check passes for a field not entered); callers that need a value coalesce.
create function private.pet_single_line(p_text text, p_max integer) returns boolean
  language sql immutable set search_path = '' as $$
  select private.is_plain_text(p_text, p_max) and p_text !~ '[\t\r\n]';
  $$;

create function private.pet_species() returns text[]
  language sql immutable set search_path = '' as $$
  select array['dog', 'cat', 'rabbit', 'guinea_pig', 'hamster', 'bird', 'fish', 'reptile', 'horse', 'other'];
  $$;

create function private.pet_event_types() returns text[]
  language sql immutable set search_path = '' as $$
  select array['vet_visit', 'vaccination', 'treatment', 'test', 'surgery', 'other'];
  $$;

-- The fields a person may mark explicitly Unknown (as opposed to not entered).
create function private.pet_unknown_fields() returns text[]
  language sql immutable set search_path = '' as $$
  select array['species', 'breed', 'birth', 'sex', 'neutered', 'weight', 'diet'];
  $$;

create function private.pet_medical_unknown_fields() returns text[]
  language sql immutable set search_path = '' as $$
  select array['allergies', 'medications', 'microchip', 'registration'];
  $$;

-- The fields a person may record explicitly as None.
create function private.pet_medical_none_fields() returns text[]
  language sql immutable set search_path = '' as $$
  select array['allergies', 'medications'];
  $$;

-- A Home's today, in its timezone.
create function private.pet_today(p_home_id uuid) returns date
  language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone coalesce(
    (select h.timezone from public.homes h where h.id = p_home_id), 'UTC'))::date;
  $$;

-- Tables -------------------------------------------------------------------------------------------------

create table private.pets (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null constraint pets_name_check check (private.pet_single_line(name, 80)),
  species text constraint pets_species_check check (species = any (private.pet_species())),
  -- Only with species 'other'.
  species_label text constraint pets_species_label_check check (private.pet_single_line(species_label, 120)),
  breed text constraint pets_breed_check check (private.pet_single_line(breed, 120)),
  -- A known birth date, or an approximate age recorded on a date (never turned into a birthday).
  birth_date date,
  age_years smallint constraint pets_age_years_check check (age_years between 0 and 60),
  age_months smallint constraint pets_age_months_check check (age_months between 0 and 11),
  age_recorded_on date,
  sex text constraint pets_sex_check check (sex in ('female', 'male')),
  neutered boolean,
  weight numeric(8, 3) constraint pets_weight_check
    check (weight > 0 and weight <= 2000 and weight = pg_catalog.round(weight, 3)),
  weight_unit text constraint pets_weight_unit_check check (weight_unit in ('kg', 'g', 'lb')),
  weight_recorded_on date,
  vet_name text constraint pets_vet_name_check check (private.pet_single_line(vet_name, 120)),
  vet_clinic text constraint pets_vet_clinic_check check (private.pet_single_line(vet_clinic, 120)),
  vet_phone text constraint pets_vet_phone_check
    check (private.pet_single_line(vet_phone, 40) and vet_phone ~ '^[0-9+() ./-]+$' and vet_phone ~ '[0-9]'),
  vet_email text constraint pets_vet_email_check
    check (private.pet_single_line(vet_email, 254) and vet_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  vet_address text constraint pets_vet_address_check check (private.is_plain_text(vet_address, 300)),
  diet text constraint pets_diet_check check (private.is_plain_text(diet, 2000)),
  care_instructions text constraint pets_care_check check (private.is_plain_text(care_instructions, 2000)),
  notes text constraint pets_notes_check check (private.is_plain_text(notes, 2000)),
  -- Fields marked explicitly Unknown; such a field has no value.
  unknown_fields text[] not null default '{}'
    constraint pets_unknown_check check (unknown_fields <@ private.pet_unknown_fields()),
  photo_file_id uuid references private.stored_files (id) on delete set null,
  revision integer not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pets_species_label_only_other check (species_label is null or species = 'other'),
  constraint pets_birth_or_age check (birth_date is null or age_years is null),
  constraint pets_age_shape check (
    (age_years is null and age_months is null and age_recorded_on is null)
    or (age_years is not null and age_months is not null and age_recorded_on is not null)),
  constraint pets_weight_shape check ((weight is null) = (weight_unit is null)
    and (weight_recorded_on is null or weight is not null)),
  constraint pets_unknown_no_value check (
    not ('species' = any (unknown_fields) and species is not null)
    and not ('breed' = any (unknown_fields) and breed is not null)
    and not ('birth' = any (unknown_fields) and (birth_date is not null or age_years is not null))
    and not ('sex' = any (unknown_fields) and sex is not null)
    and not ('neutered' = any (unknown_fields) and neutered is not null)
    and not ('weight' = any (unknown_fields) and weight is not null)
    and not ('diet' = any (unknown_fields) and diet is not null))
);

create index pets_home_idx on private.pets (home_id) where deleted_at is null;
create index pets_photo_idx on private.pets (photo_file_id) where photo_file_id is not null;

-- The sensitive part of a profile: only people with medical view ever read it.
create table private.pet_medical_details (
  pet_id uuid primary key references private.pets (id) on delete cascade,
  allergies text constraint pet_medical_details_allergies_check check (private.is_plain_text(allergies, 2000)),
  medications text constraint pet_medical_details_medications_check check (private.is_plain_text(medications, 2000)),
  microchip text constraint pet_medical_details_microchip_check check (private.pet_single_line(microchip, 64)),
  registration text constraint pet_medical_details_registration_check
    check (private.pet_single_line(registration, 64)),
  identification_notes text constraint pet_medical_details_id_notes_check
    check (private.is_plain_text(identification_notes, 500)),
  medical_notes text constraint pet_medical_details_notes_check check (private.is_plain_text(medical_notes, 2000)),
  unknown_fields text[] not null default '{}'
    constraint pet_medical_details_unknown_check check (unknown_fields <@ private.pet_medical_unknown_fields()),
  none_fields text[] not null default '{}'
    constraint pet_medical_details_none_check check (none_fields <@ private.pet_medical_none_fields()),
  revision integer not null default 1,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint pet_medical_details_states check (
    not (unknown_fields && none_fields)
    and not ('allergies' = any (unknown_fields || none_fields) and allergies is not null)
    and not ('medications' = any (unknown_fields || none_fields) and medications is not null)
    and not ('microchip' = any (unknown_fields) and microchip is not null)
    and not ('registration' = any (unknown_fields) and registration is not null))
);

create table private.pet_medical_entries (
  id uuid primary key,
  pet_id uuid not null references private.pets (id) on delete cascade,
  event_type text not null constraint pet_medical_entries_type_check check (event_type = any (private.pet_event_types())),
  event_date date not null,
  title text constraint pet_medical_entries_title_check check (private.pet_single_line(title, 120)),
  veterinarian text constraint pet_medical_entries_vet_check check (private.pet_single_line(veterinarian, 120)),
  location text constraint pet_medical_entries_location_check check (private.pet_single_line(location, 200)),
  treatment text constraint pet_medical_entries_treatment_check check (private.is_plain_text(treatment, 2000)),
  notes text constraint pet_medical_entries_notes_check check (private.is_plain_text(notes, 2000)),
  follow_up_date date,
  revision integer not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pet_medical_entries_follow_up check (follow_up_date is null or follow_up_date >= event_date)
);

create index pet_medical_entries_pet_idx on private.pet_medical_entries (pet_id, event_date desc)
  where deleted_at is null;

create table private.pet_medical_attachments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references private.pet_medical_entries (id) on delete cascade,
  file_id uuid not null references private.stored_files (id) on delete cascade,
  display_name text not null
    constraint pet_medical_attachments_name_check check (private.is_visible_name(display_name, 200)),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  -- In the trash on its own (an entry of type pet_medical_attachment).
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null
);

create index pet_medical_attachments_entry_idx on private.pet_medical_attachments (entry_id);
create unique index pet_medical_attachments_file_key on private.pet_medical_attachments (file_id);

-- Uploads in progress: which pet or entry, and (for attachments) the name it will show.
create table private.pet_photo_uploads (
  file_id uuid primary key references private.stored_files (id) on delete cascade,
  pet_id uuid not null references private.pets (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table private.pet_medical_attachment_uploads (
  file_id uuid primary key references private.stored_files (id) on delete cascade,
  entry_id uuid not null references private.pet_medical_entries (id) on delete cascade,
  display_name text not null
    constraint pet_medical_attachment_uploads_name_check check (private.is_visible_name(display_name, 200)),
  created_at timestamptz not null default now()
);

create index pet_medical_attachment_uploads_entry_idx on private.pet_medical_attachment_uploads (entry_id);

-- Medical access granted to a member of a Home. The Owner has 'manage' without a row. A grant belongs
-- to the membership: it ends with it and never reappears on a later re-join.
create table private.pet_medical_access (
  home_id uuid not null,
  user_id uuid not null,
  level text not null constraint pet_medical_access_level_check check (level in ('view', 'manage')),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  constraint pet_medical_access_pkey primary key (home_id, user_id),
  constraint pet_medical_access_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

alter table private.pets enable row level security;
alter table private.pet_medical_details enable row level security;
alter table private.pet_medical_entries enable row level security;
alter table private.pet_medical_attachments enable row level security;
alter table private.pet_photo_uploads enable row level security;
alter table private.pet_medical_attachment_uploads enable row level security;
alter table private.pet_medical_access enable row level security;

-- The medical documents a pet's trash entry holds. They are kept apart from the shared
-- trash_entry_files, whose count and sizes every trash viewer sees: a pet manager without medical view
-- must not learn from the pet's trash entry whether it has medical documents, or how many.
create table private.pet_trash_files (
  entry_id uuid not null references private.trash_entries (id) on delete cascade,
  file_id uuid not null references private.stored_files (id) on delete cascade,
  primary key (entry_id, file_id)
);
alter table private.pet_trash_files enable row level security;
revoke all on table private.pets, private.pet_medical_details, private.pet_medical_entries,
  private.pet_medical_attachments, private.pet_photo_uploads, private.pet_medical_attachment_uploads,
  private.pet_medical_access, private.pet_trash_files
  from public, anon, authenticated, service_role;

-- Access ------------------------------------------------------------------------------------------------

-- What a person may do with a Home's pets: 'manage' (the Owner, Administrators granted manageHomePets),
-- 'view' (every other current member) or null (not a member).
create function private.pet_access(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null or p_home_id is null then null
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomePets') then 'manage'
    when exists (select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id)
      then 'view'
  end;
  $$;

-- A person's medical access in a Home: 'manage', 'view' or null (none, or not a member).
create function private.pet_medical_level(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case when m.role = 'owner' then 'manage' else a.level end
  from public.home_memberships m
  left join private.pet_medical_access a on a.home_id = m.home_id and a.user_id = m.user_id
  where m.home_id = p_home_id and m.user_id = p_user_id and p_user_id is not null;
  $$;

create function private.pet_medical_can_view(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(private.pet_medical_level(p_home_id, p_user_id) in ('view', 'manage'), false);
  $$;

create function private.pet_medical_can_manage(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(private.pet_medical_level(p_home_id, p_user_id) = 'manage', false);
  $$;

-- 42501 for a Home the caller is not in (the same answer as for one that does not exist).
create function private.require_pet_home(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is null or private.pet_access(p_home_id, p_user_id) is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- The pet, locked, when the caller may see it now (a current member of its Home and the pet is not in
-- the trash); otherwise an empty row. Every write takes this lock first: pet, then entry, then pool.
create function private.lock_pet(p_pet_id uuid, p_user_id uuid) returns private.pets
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pet private.pets;
  begin
    select * into v_pet from private.pets p where p.id = p_pet_id for update;
    if not found or v_pet.deleted_at is not null or private.pet_access(v_pet.home_id, p_user_id) is null then
      return null;
    end if;
    return v_pet;
  end
  $$;

-- Serializes the per-Home limit check, so two creates or restores cannot both take the last place.
create function private.lock_pet_home(p_home_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pets:' || p_home_id::text, 0));
  $$;

create function private.pet_home_full(p_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.pets p where p.home_id = p_home_id and p.deleted_at is null)
    >= private.pet_limit('pets');
  $$;

-- Ids and field names only: never a value, a name or a title.
create function private.audit_pet(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  select private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details);
  $$;

-- Reading request values ---------------------------------------------------------------------------------
-- A missing key or JSON null is "not entered"; anything else must be valid, or the whole request is
-- refused with 22023 and nothing is saved.

create function private.pet_json_text(p_body jsonb, p_key text, p_max integer, p_single boolean)
returns text
  language plpgsql immutable set search_path = '' as $$
  declare
    v_value text;
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'string' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    v_value := p_body ->> p_key;
    if not coalesce(case when p_single then private.pet_single_line(v_value, p_max)
        else private.is_plain_text(v_value, p_max) end, false) then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_value;
  end
  $$;

create function private.pet_json_date(p_body jsonb, p_key text) returns date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_value text;
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    v_value := case when pg_catalog.jsonb_typeof(p_body -> p_key) = 'string' then p_body ->> p_key end;
    if v_value is null or v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    begin
      return v_value::date;
    exception when others then
      raise exception 'invalid %', p_key using errcode = '22023';
    end;
  end
  $$;

create function private.pet_json_number(p_body jsonb, p_key text) returns numeric
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'number' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return (p_body ->> p_key)::numeric;
  end
  $$;

create function private.pet_json_bool(p_body jsonb, p_key text) returns boolean
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'boolean' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return (p_body ->> p_key)::boolean;
  end
  $$;

create function private.pet_json_choice(p_body jsonb, p_key text, p_allowed text[]) returns text
  language plpgsql immutable set search_path = '' as $$
  declare
    v_value text;
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    v_value := case when pg_catalog.jsonb_typeof(p_body -> p_key) = 'string' then p_body ->> p_key end;
    if v_value is null or not (v_value = any (p_allowed)) then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_value;
  end
  $$;

-- A list of field names, each from p_allowed and at most once.
create function private.pet_json_fields(p_body jsonb, p_key text, p_allowed text[]) returns text[]
  language plpgsql immutable set search_path = '' as $$
  declare
    v_fields text[];
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return '{}';
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'array'
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_body -> p_key) e
         where pg_catalog.jsonb_typeof(e) <> 'string') then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    select coalesce(pg_catalog.array_agg(e order by e), '{}') into v_fields
      from pg_catalog.jsonb_array_elements_text(p_body -> p_key) e;
    if not (v_fields <@ p_allowed)
       or pg_catalog.cardinality(v_fields) <> (select count(distinct x) from pg_catalog.unnest(v_fields) x) then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_fields;
  end
  $$;

-- Output -------------------------------------------------------------------------------------------------

create function private.pet_summary_json(p_pet private.pets) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_pet.id,
    'name', p_pet.name,
    'species', p_pet.species,
    'speciesLabel', p_pet.species_label,
    'birthDate', p_pet.birth_date,
    'ageYears', p_pet.age_years,
    'ageMonths', p_pet.age_months,
    'ageRecordedOn', p_pet.age_recorded_on,
    'photoFileId', p_pet.photo_file_id
  );
  $$;

-- The basic profile: what every current member of the pet's Home may see. Never a sensitive field.
create function private.pet_json(p_pet private.pets) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select private.pet_summary_json(p_pet) || pg_catalog.jsonb_build_object(
    'homeId', p_pet.home_id,
    'breed', p_pet.breed,
    'sex', p_pet.sex,
    'neutered', p_pet.neutered,
    'weight', p_pet.weight,
    'weightUnit', p_pet.weight_unit,
    'weightRecordedOn', p_pet.weight_recorded_on,
    'vetName', p_pet.vet_name,
    'vetClinic', p_pet.vet_clinic,
    'vetPhone', p_pet.vet_phone,
    'vetEmail', p_pet.vet_email,
    'vetAddress', p_pet.vet_address,
    'diet', p_pet.diet,
    'careInstructions', p_pet.care_instructions,
    'notes', p_pet.notes,
    'unknown', pg_catalog.to_jsonb(p_pet.unknown_fields),
    'revision', p_pet.revision,
    'createdAt', p_pet.created_at,
    'updatedAt', p_pet.updated_at
  );
  $$;

-- Reading ------------------------------------------------------------------------------------------------

-- The Home's pets (not in the trash), by name, with what the caller may do. 42501 for a Home the caller
-- is not in.
create function public.list_pets(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_pet_home(p_home_id, v_user_id);
    return pg_catalog.jsonb_build_object(
      'access', private.pet_access(p_home_id, v_user_id),
      'medicalAccess', private.pet_medical_level(p_home_id, v_user_id),
      'limit', private.pet_limit('pets'),
      'pets', coalesce((
        select pg_catalog.jsonb_agg(private.pet_summary_json(p) order by pg_catalog.lower(p.name), p.id)
        from private.pets p where p.home_id = p_home_id and p.deleted_at is null), '[]'::jsonb)
    );
  end
  $$;

-- One pet's basic profile with the caller's access, or null when they may not see it (or it is gone).
create function public.get_pet(p_pet_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
  begin
    select * into v_pet from private.pets p where p.id = p_pet_id and p.deleted_at is null;
    if not found or private.pet_access(v_pet.home_id, v_user_id) is null then
      return null;
    end if;
    return private.pet_json(v_pet) || pg_catalog.jsonb_build_object(
      'access', private.pet_access(v_pet.home_id, v_user_id),
      'medicalAccess', private.pet_medical_level(v_pet.home_id, v_user_id),
      'today', private.pet_today(v_pet.home_id)
    );
  end
  $$;

-- A pet's medical information for someone with medical view: the sensitive details and every medical
-- entry (newest first) with its attachments. Null for everyone else, and for a pet they may not see:
-- nothing tells them whether there is any.
create function public.get_pet_medical(p_pet_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_details private.pet_medical_details;
  begin
    select * into v_pet from private.pets p where p.id = p_pet_id and p.deleted_at is null;
    if not found or not private.pet_medical_can_view(v_pet.home_id, v_user_id) then
      return null;
    end if;
    select * into v_details from private.pet_medical_details d where d.pet_id = v_pet.id;
    return pg_catalog.jsonb_build_object(
      'petId', v_pet.id,
      'level', private.pet_medical_level(v_pet.home_id, v_user_id),
      'today', private.pet_today(v_pet.home_id),
      'details', pg_catalog.jsonb_build_object(
        'allergies', v_details.allergies,
        'medications', v_details.medications,
        'microchip', v_details.microchip,
        'registration', v_details.registration,
        'identificationNotes', v_details.identification_notes,
        'medicalNotes', v_details.medical_notes,
        'unknown', pg_catalog.to_jsonb(coalesce(v_details.unknown_fields, '{}')),
        'none', pg_catalog.to_jsonb(coalesce(v_details.none_fields, '{}')),
        'revision', coalesce(v_details.revision, 0),
        'updatedAt', v_details.updated_at
      ),
      'entries', coalesce((
        select pg_catalog.jsonb_agg(private.pet_medical_entry_json(e) order by e.event_date desc, e.created_at desc, e.id)
        from private.pet_medical_entries e
        where e.pet_id = v_pet.id and e.deleted_at is null), '[]'::jsonb)
    );
  end
  $$;

create function private.pet_medical_entry_json(p_entry private.pet_medical_entries) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_entry.id,
    'petId', p_entry.pet_id,
    'type', p_entry.event_type,
    'date', p_entry.event_date,
    'title', p_entry.title,
    'veterinarian', p_entry.veterinarian,
    'location', p_entry.location,
    'treatment', p_entry.treatment,
    'notes', p_entry.notes,
    'followUpDate', p_entry.follow_up_date,
    'revision', p_entry.revision,
    'createdAt', p_entry.created_at,
    'updatedAt', p_entry.updated_at,
    'attachments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'fileId', a.file_id, 'name', a.display_name,
          'contentType', f.content_type, 'size', f.size_bytes, 'addedAt', a.added_at)
        order by a.added_at, a.id)
      from private.pet_medical_attachments a
      join private.stored_files f on f.id = a.file_id
      where a.entry_id = p_entry.id and a.removed_at is null and f.status = 'ready'), '[]'::jsonb)
  );
  $$;

-- One medical entry for someone with medical view; null otherwise (also for a forged or missing id).
create function public.get_pet_medical_entry(p_entry_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.pet_medical_entries;
    v_pet private.pets;
  begin
    select * into v_entry from private.pet_medical_entries e where e.id = p_entry_id and e.deleted_at is null;
    if not found then
      return null;
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id and p.deleted_at is null;
    if not found or not private.pet_medical_can_view(v_pet.home_id, v_user_id) then
      return null;
    end if;
    return private.pet_medical_entry_json(v_entry) || pg_catalog.jsonb_build_object(
      'petName', v_pet.name,
      'homeId', v_pet.home_id,
      'level', private.pet_medical_level(v_pet.home_id, v_user_id),
      'today', private.pet_today(v_pet.home_id)
    );
  end
  $$;

-- Pets: create, update, delete ---------------------------------------------------------------------------

-- Creates a pet with only its name. A retry with the same id by the same person answers 'exists'.
-- Outcomes: 'created', 'exists', 'id_taken', 'not_permitted', 'limit_reached'. 42501 for a Home the
-- caller is not in; 22023 for an invalid name.
create function public.create_pet(p_id uuid, p_home_id uuid, p_name text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.pets;
  begin
    if p_id is null or not coalesce(private.pet_single_line(p_name, private.pet_limit('name')), false) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.require_pet_home(p_home_id, v_user_id);
    perform private.lock_pet_home(p_home_id);
    select * into v_existing from private.pets p where p.id = p_id;
    if found then
      return pg_catalog.jsonb_build_object('outcome',
        case when v_existing.home_id = p_home_id and v_existing.created_by = v_user_id then 'exists'
          else 'id_taken' end);
    end if;
    if private.pet_access(p_home_id, v_user_id) <> 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if private.pet_home_full(p_home_id) then
      return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
    end if;
    insert into private.pets (id, home_id, name, created_by, updated_by)
      values (p_id, p_home_id, p_name, v_user_id, v_user_id);
    perform private.audit_pet('pet.created', p_home_id, 'pet', p_id);
    return pg_catalog.jsonb_build_object('outcome', 'created', 'id', p_id);
  end
  $$;

-- Replaces the basic profile with p_profile (every basic field; a missing one becomes not entered). The
-- photo is changed with its own calls. Outcomes: 'saved', 'stale' (with the current revision),
-- 'not_found', 'not_permitted'. 22023 for any invalid value: nothing is saved.
create function public.update_pet(p_pet_id uuid, p_expected_revision integer, p_profile jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_today date;
    v_species text;
    v_birth date;
    v_age_years numeric;
    v_age_months numeric;
    v_age_on date;
    v_weight numeric;
    v_weight_unit text;
    v_weight_on date;
    v_unknown text[];
    v_changed text[];
    v_new private.pets;
  begin
    if p_pet_id is null or p_expected_revision is null or p_profile is null
       or pg_catalog.jsonb_typeof(p_profile) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.pet_access(v_pet.home_id, v_user_id) <> 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_pet.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_pet.revision);
    end if;
    v_today := private.pet_today(v_pet.home_id);

    v_new := v_pet;
    v_new.name := private.pet_json_text(p_profile, 'name', private.pet_limit('name'), true);
    if v_new.name is null then
      raise exception 'invalid name' using errcode = '22023';
    end if;
    v_species := private.pet_json_choice(p_profile, 'species', private.pet_species());
    v_new.species := v_species;
    v_new.species_label := private.pet_json_text(p_profile, 'speciesLabel', private.pet_limit('short'), true);
    if v_new.species_label is not null and v_species is distinct from 'other' then
      raise exception 'invalid speciesLabel' using errcode = '22023';
    end if;
    v_new.breed := private.pet_json_text(p_profile, 'breed', private.pet_limit('short'), true);

    v_birth := private.pet_json_date(p_profile, 'birthDate');
    if v_birth is not null and (v_birth > v_today or v_birth < date '1950-01-01') then
      raise exception 'invalid birthDate' using errcode = '22023';
    end if;
    v_age_years := private.pet_json_number(p_profile, 'ageYears');
    v_age_months := private.pet_json_number(p_profile, 'ageMonths');
    v_age_on := private.pet_json_date(p_profile, 'ageRecordedOn');
    if v_age_years is null and v_age_months is null then
      if v_age_on is not null then
        raise exception 'invalid ageRecordedOn' using errcode = '22023';
      end if;
    else
      v_age_years := coalesce(v_age_years, 0);
      v_age_months := coalesce(v_age_months, 0);
      if v_birth is not null or v_age_years <> pg_catalog.trunc(v_age_years) or v_age_months <> pg_catalog.trunc(v_age_months)
         or v_age_years not between 0 and 60 or v_age_months not between 0 and 11
         or (v_age_years = 0 and v_age_months = 0) then
        raise exception 'invalid age' using errcode = '22023';
      end if;
      v_age_on := coalesce(v_age_on, v_today);
      if v_age_on > v_today or v_age_on < date '1950-01-01' then
        raise exception 'invalid ageRecordedOn' using errcode = '22023';
      end if;
    end if;
    v_new.birth_date := v_birth;
    v_new.age_years := v_age_years;
    v_new.age_months := v_age_months;
    v_new.age_recorded_on := case when v_age_years is null then null else v_age_on end;

    v_new.sex := private.pet_json_choice(p_profile, 'sex', array['female', 'male']);
    v_new.neutered := private.pet_json_bool(p_profile, 'neutered');

    v_weight := private.pet_json_number(p_profile, 'weight');
    v_weight_unit := private.pet_json_choice(p_profile, 'weightUnit', array['kg', 'g', 'lb']);
    v_weight_on := private.pet_json_date(p_profile, 'weightRecordedOn');
    if (v_weight is null) <> (v_weight_unit is null)
       or (v_weight is not null and (v_weight <= 0 or v_weight > 2000 or v_weight <> pg_catalog.round(v_weight, 3)))
       or (v_weight_on is not null and (v_weight is null or v_weight_on > v_today or v_weight_on < date '1950-01-01')) then
      raise exception 'invalid weight' using errcode = '22023';
    end if;
    v_new.weight := v_weight;
    v_new.weight_unit := v_weight_unit;
    v_new.weight_recorded_on := v_weight_on;

    v_new.vet_name := private.pet_json_text(p_profile, 'vetName', private.pet_limit('short'), true);
    v_new.vet_clinic := private.pet_json_text(p_profile, 'vetClinic', private.pet_limit('short'), true);
    v_new.vet_phone := private.pet_json_text(p_profile, 'vetPhone', private.pet_limit('phone'), true);
    if v_new.vet_phone is not null and (v_new.vet_phone !~ '^[0-9+() ./-]+$' or v_new.vet_phone !~ '[0-9]') then
      raise exception 'invalid vetPhone' using errcode = '22023';
    end if;
    v_new.vet_email := private.pet_json_text(p_profile, 'vetEmail', private.pet_limit('email'), true);
    if v_new.vet_email is not null and v_new.vet_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'invalid vetEmail' using errcode = '22023';
    end if;
    v_new.vet_address := private.pet_json_text(p_profile, 'vetAddress', private.pet_limit('address'), false);
    v_new.diet := private.pet_json_text(p_profile, 'diet', private.pet_limit('long'), false);
    v_new.care_instructions := private.pet_json_text(p_profile, 'careInstructions', private.pet_limit('long'), false);
    v_new.notes := private.pet_json_text(p_profile, 'notes', private.pet_limit('long'), false);

    v_unknown := private.pet_json_fields(p_profile, 'unknown', private.pet_unknown_fields());
    if ('species' = any (v_unknown) and v_new.species is not null)
       or ('breed' = any (v_unknown) and v_new.breed is not null)
       or ('birth' = any (v_unknown) and (v_new.birth_date is not null or v_new.age_years is not null))
       or ('sex' = any (v_unknown) and v_new.sex is not null)
       or ('neutered' = any (v_unknown) and v_new.neutered is not null)
       or ('weight' = any (v_unknown) and v_new.weight is not null)
       or ('diet' = any (v_unknown) and v_new.diet is not null) then
      raise exception 'invalid unknown' using errcode = '22023';
    end if;
    v_new.unknown_fields := v_unknown;

    -- Which fields changed, by name only (the audit never holds a value).
    select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(v_new)) n(k, v)
      where k not in ('revision', 'updated_at', 'updated_by')
        and n.v is distinct from (pg_catalog.to_jsonb(v_pet) -> k);
    if pg_catalog.cardinality(v_changed) = 0 then
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_pet.revision);
    end if;

    update private.pets p set
      name = v_new.name, species = v_new.species, species_label = v_new.species_label, breed = v_new.breed,
      birth_date = v_new.birth_date, age_years = v_new.age_years, age_months = v_new.age_months,
      age_recorded_on = v_new.age_recorded_on, sex = v_new.sex, neutered = v_new.neutered,
      weight = v_new.weight, weight_unit = v_new.weight_unit, weight_recorded_on = v_new.weight_recorded_on,
      vet_name = v_new.vet_name, vet_clinic = v_new.vet_clinic, vet_phone = v_new.vet_phone,
      vet_email = v_new.vet_email, vet_address = v_new.vet_address, diet = v_new.diet,
      care_instructions = v_new.care_instructions, notes = v_new.notes, unknown_fields = v_new.unknown_fields,
      revision = p.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where p.id = v_pet.id
      returning * into v_new;
    perform private.audit_pet('pet.updated', v_pet.home_id, 'pet', v_pet.id,
      pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_changed)));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_new.revision);
  end
  $$;

-- Moves a pet to the Home's trash with everything that belongs to it (sensitive details, medical
-- entries and attachments, photo). They come back together. Outcomes: 'deleted' (with the trash entry
-- id), 'stale', 'not_found', 'not_permitted'.
create function public.delete_pet(p_pet_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_files uuid[];
    v_file uuid;
    v_entry uuid;
  begin
    if p_pet_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.pet_access(v_pet.home_id, v_user_id) <> 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_pet.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_pet.revision);
    end if;
    update private.pets p set deleted_at = pg_catalog.now(), revision = p.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where p.id = v_pet.id;
    -- The files of attachments not in the trash on their own. They are retired with the pet but kept
    -- out of the shared trash_entry_files (see pet_trash_files), so the entry shows only the photo.
    select coalesce(pg_catalog.array_agg(a.file_id order by a.file_id), '{}') into v_files
      from private.pet_medical_attachments a
      join private.pet_medical_entries e on e.id = a.entry_id
      where e.pet_id = v_pet.id and e.deleted_at is null and a.removed_at is null;
    -- The Home's pool first, as trash_move does.
    perform 1 from private.storage_pools p
      where p.id in (select f.pool_id from private.stored_files f
        where f.id = any (v_files || v_pet.photo_file_id))
      order by p.id for update;
    v_entry := private.trash_move(v_user_id, 'pets', 'pet', v_pet.id, null, v_pet.home_id, v_pet.name,
      case when v_pet.photo_file_id is null then '{}'::uuid[] else array[v_pet.photo_file_id] end);
    foreach v_file in array v_files loop
      perform private.retire_file(v_file);
      if exists (select 1 from private.stored_files f where f.id = v_file and f.status = 'deleted') then
        insert into private.pet_trash_files (entry_id, file_id) values (v_entry, v_file)
          on conflict do nothing;
      end if;
    end loop;
    perform private.audit_pet('pet.deleted', v_pet.home_id, 'pet', v_pet.id);
    return pg_catalog.jsonb_build_object('outcome', 'deleted', 'entryId', v_entry);
  end
  $$;

-- Sensitive details ---------------------------------------------------------------------------------------

-- Replaces the sensitive details (medical manage). Outcomes: 'saved', 'stale', 'not_found' (also without
-- medical view), 'not_permitted' (view only). 22023 for any invalid value.
create function public.set_pet_medical_details(p_pet_id uuid, p_expected_revision integer, p_details jsonb)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_current private.pet_medical_details;
    v_new private.pet_medical_details;
    v_changed text[];
  begin
    if p_pet_id is null or p_expected_revision is null or p_details is null
       or pg_catalog.jsonb_typeof(p_details) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null or not private.pet_medical_can_view(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    select * into v_current from private.pet_medical_details d where d.pet_id = v_pet.id for update;
    if coalesce(v_current.revision, 0) <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', coalesce(v_current.revision, 0));
    end if;

    v_new.pet_id := v_pet.id;
    v_new.allergies := private.pet_json_text(p_details, 'allergies', private.pet_limit('long'), false);
    v_new.medications := private.pet_json_text(p_details, 'medications', private.pet_limit('long'), false);
    v_new.microchip := private.pet_json_text(p_details, 'microchip', private.pet_limit('identifier'), true);
    v_new.registration := private.pet_json_text(p_details, 'registration', private.pet_limit('identifier'), true);
    v_new.identification_notes := private.pet_json_text(p_details, 'identificationNotes',
      private.pet_limit('identification_notes'), false);
    v_new.medical_notes := private.pet_json_text(p_details, 'medicalNotes', private.pet_limit('long'), false);
    v_new.unknown_fields := private.pet_json_fields(p_details, 'unknown', private.pet_medical_unknown_fields());
    v_new.none_fields := private.pet_json_fields(p_details, 'none', private.pet_medical_none_fields());
    if v_new.unknown_fields && v_new.none_fields
       or ('allergies' = any (v_new.unknown_fields || v_new.none_fields) and v_new.allergies is not null)
       or ('medications' = any (v_new.unknown_fields || v_new.none_fields) and v_new.medications is not null)
       or ('microchip' = any (v_new.unknown_fields) and v_new.microchip is not null)
       or ('registration' = any (v_new.unknown_fields) and v_new.registration is not null) then
      raise exception 'invalid states' using errcode = '22023';
    end if;

    select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(v_new)) n(k, v)
      where k in ('allergies', 'medications', 'microchip', 'registration', 'identification_notes',
          'medical_notes', 'unknown_fields', 'none_fields')
        and n.v is distinct from coalesce(pg_catalog.to_jsonb(v_current) -> k,
          case when k in ('unknown_fields', 'none_fields') then '[]'::jsonb else 'null'::jsonb end);
    if pg_catalog.cardinality(v_changed) = 0 then
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', coalesce(v_current.revision, 0));
    end if;

    insert into private.pet_medical_details as d (
      pet_id, allergies, medications, microchip, registration, identification_notes, medical_notes,
      unknown_fields, none_fields, revision, updated_by, updated_at
    ) values (
      v_pet.id, v_new.allergies, v_new.medications, v_new.microchip, v_new.registration,
      v_new.identification_notes, v_new.medical_notes, v_new.unknown_fields, v_new.none_fields, 1,
      v_user_id, pg_catalog.now()
    )
    on conflict (pet_id) do update set
      allergies = excluded.allergies, medications = excluded.medications, microchip = excluded.microchip,
      registration = excluded.registration, identification_notes = excluded.identification_notes,
      medical_notes = excluded.medical_notes, unknown_fields = excluded.unknown_fields,
      none_fields = excluded.none_fields, revision = d.revision + 1, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
    returning * into v_new;
    perform private.audit_pet('pet.medical_details.updated', v_pet.home_id, 'pet', v_pet.id,
      pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_changed)));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_new.revision);
  end
  $$;

-- Medical entries ----------------------------------------------------------------------------------------

-- Reads and checks an entry's fields for a pet (22023 for anything invalid).
create function private.pet_medical_entry_values(p_pet private.pets, p_body jsonb)
returns private.pet_medical_entries
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_entry private.pet_medical_entries;
    v_today date := private.pet_today(p_pet.home_id);
    v_earliest date := greatest(date '1980-01-01', coalesce(p_pet.birth_date, date '1980-01-01'));
  begin
    if p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_entry.event_type := private.pet_json_choice(p_body, 'type', private.pet_event_types());
    v_entry.event_date := private.pet_json_date(p_body, 'date');
    if v_entry.event_type is null or v_entry.event_date is null
       or v_entry.event_date < v_earliest or v_entry.event_date > v_today + 730 then
      raise exception 'invalid date' using errcode = '22023';
    end if;
    v_entry.title := private.pet_json_text(p_body, 'title', private.pet_limit('short'), true);
    v_entry.veterinarian := private.pet_json_text(p_body, 'veterinarian', private.pet_limit('short'), true);
    v_entry.location := private.pet_json_text(p_body, 'location', private.pet_limit('location'), true);
    v_entry.treatment := private.pet_json_text(p_body, 'treatment', private.pet_limit('long'), false);
    v_entry.notes := private.pet_json_text(p_body, 'notes', private.pet_limit('long'), false);
    v_entry.follow_up_date := private.pet_json_date(p_body, 'followUpDate');
    if v_entry.follow_up_date is not null
       and (v_entry.follow_up_date < v_entry.event_date or v_entry.follow_up_date > v_today + 1826) then
      raise exception 'invalid followUpDate' using errcode = '22023';
    end if;
    return v_entry;
  end
  $$;

-- Adds a medical entry (medical manage). A retry with the same id by the same person answers 'exists'.
-- Outcomes: 'created', 'exists', 'id_taken', 'not_found' (no such pet, or no medical view),
-- 'not_permitted', 'limit_reached'.
create function public.create_pet_medical_entry(p_id uuid, p_pet_id uuid, p_entry jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_existing private.pet_medical_entries;
    v_values private.pet_medical_entries;
  begin
    if p_id is null or p_pet_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null or not private.pet_medical_can_view(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_existing from private.pet_medical_entries e where e.id = p_id;
    if found then
      return pg_catalog.jsonb_build_object('outcome',
        case when v_existing.pet_id = v_pet.id and v_existing.created_by = v_user_id then 'exists'
          else 'id_taken' end);
    end if;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_values := private.pet_medical_entry_values(v_pet, p_entry);
    if (select count(*) from private.pet_medical_entries e where e.pet_id = v_pet.id and e.deleted_at is null)
       >= private.pet_limit('entries') then
      return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
    end if;
    insert into private.pet_medical_entries (
      id, pet_id, event_type, event_date, title, veterinarian, location, treatment, notes, follow_up_date,
      created_by, updated_by
    ) values (
      p_id, v_pet.id, v_values.event_type, v_values.event_date, v_values.title, v_values.veterinarian,
      v_values.location, v_values.treatment, v_values.notes, v_values.follow_up_date, v_user_id, v_user_id
    );
    perform private.audit_pet('pet.medical_entry.created', v_pet.home_id, 'pet_medical_entry', p_id,
      pg_catalog.jsonb_build_object('petId', v_pet.id));
    return pg_catalog.jsonb_build_object('outcome', 'created', 'id', p_id);
  end
  $$;

-- The entry, locked with its pet, when the caller has medical view; an empty row otherwise.
create function private.lock_pet_medical_entry(p_entry_id uuid, p_user_id uuid)
returns private.pet_medical_entries
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.pet_medical_entries;
    v_pet private.pets;
  begin
    select * into v_entry from private.pet_medical_entries e where e.id = p_entry_id;
    if not found then
      return null;
    end if;
    v_pet := private.lock_pet(v_entry.pet_id, p_user_id);
    if v_pet.id is null or not private.pet_medical_can_view(v_pet.home_id, p_user_id) then
      return null;
    end if;
    select * into v_entry from private.pet_medical_entries e where e.id = p_entry_id for update;
    if v_entry.deleted_at is not null then
      return null;
    end if;
    return v_entry;
  end
  $$;

-- Corrects an entry in place (medical manage). Outcomes: 'saved', 'stale', 'not_found',
-- 'not_permitted'. 22023 for any invalid value.
create function public.update_pet_medical_entry(p_entry_id uuid, p_expected_revision integer, p_entry jsonb)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.pet_medical_entries;
    v_pet private.pets;
    v_values private.pet_medical_entries;
    v_changed text[];
  begin
    if p_entry_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_entry := private.lock_pet_medical_entry(p_entry_id, v_user_id);
    if v_entry.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_entry.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_entry.revision);
    end if;
    v_values := private.pet_medical_entry_values(v_pet, p_entry);
    select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
      from pg_catalog.jsonb_each(pg_catalog.to_jsonb(v_values)) n(k, v)
      where k in ('event_type', 'event_date', 'title', 'veterinarian', 'location', 'treatment', 'notes',
          'follow_up_date')
        and n.v is distinct from (pg_catalog.to_jsonb(v_entry) -> k);
    if pg_catalog.cardinality(v_changed) = 0 then
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_entry.revision);
    end if;
    update private.pet_medical_entries e set
      event_type = v_values.event_type, event_date = v_values.event_date, title = v_values.title,
      veterinarian = v_values.veterinarian, location = v_values.location, treatment = v_values.treatment,
      notes = v_values.notes, follow_up_date = v_values.follow_up_date, revision = e.revision + 1,
      updated_by = v_user_id, updated_at = pg_catalog.now()
      where e.id = v_entry.id
      returning * into v_entry;
    perform private.audit_pet('pet.medical_entry.updated', v_pet.home_id, 'pet_medical_entry', v_entry.id,
      pg_catalog.jsonb_build_object('petId', v_pet.id, 'fields', pg_catalog.to_jsonb(v_changed)));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_entry.revision);
  end
  $$;

-- Moves an entry and its attachments to the Home's trash (medical manage). Outcomes: 'deleted' (with
-- the trash entry id), 'stale', 'not_found', 'not_permitted'.
create function public.delete_pet_medical_entry(p_entry_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.pet_medical_entries;
    v_pet private.pets;
    v_files uuid[];
    v_trash uuid;
  begin
    if p_entry_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_entry := private.lock_pet_medical_entry(p_entry_id, v_user_id);
    if v_entry.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_entry.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_entry.revision);
    end if;
    update private.pet_medical_entries e set deleted_at = pg_catalog.now(), revision = e.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where e.id = v_entry.id;
    select coalesce(pg_catalog.array_agg(a.file_id), '{}') into v_files
      from private.pet_medical_attachments a where a.entry_id = v_entry.id and a.removed_at is null;
    v_trash := private.trash_move(v_user_id, 'pets', 'pet_medical_entry', v_entry.id, null, v_pet.home_id,
      coalesce(v_entry.title, pg_catalog.to_char(v_entry.event_date, 'YYYY-MM-DD')), v_files);
    perform private.audit_pet('pet.medical_entry.deleted', v_pet.home_id, 'pet_medical_entry', v_entry.id,
      pg_catalog.jsonb_build_object('petId', v_pet.id));
    return pg_catalog.jsonb_build_object('outcome', 'deleted', 'entryId', v_trash);
  end
  $$;

-- Files: policy -----------------------------------------------------------------------------------------

-- A medical attachment: JPEG, PNG, WebP or PDF (invoices, certificates), at most 10 MB; images are
-- re-encoded in their own format without metadata, PDFs checked by signature (brief S31). A pet photo:
-- JPEG, PNG or WebP up to 10 MB, stored as a WebP the server made. apps/web/src/pets/schema.ts has the
-- same lists.
create function private.pet_attachment_type(p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'), false);
  $$;

create or replace function private.upload_max_bytes(p_purpose text) returns bigint
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then 5242880::bigint
    when 'task_attachment' then 10485760::bigint  -- 10 MB (brief S19c)
    when 'recipe_cover' then 10485760::bigint     -- 10 MB (brief S24)
    when 'pet_photo' then 10485760::bigint        -- 10 MB (brief S31)
    when 'pet_medical_attachment' then 10485760::bigint
  end;
  $$;

create or replace function private.upload_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'pet_photo' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'pet_medical_attachment' then private.pet_attachment_type(p_type)
    else false
  end;
  $$;

create or replace function private.stored_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type = 'image/webp'
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type = 'image/webp'
    when 'pet_photo' then p_type = 'image/webp'
    when 'pet_medical_attachment' then private.pet_attachment_type(p_type)
    else false
  end;
  $$;

-- Opens an upload in the pet's Home pool for p_purpose, after the caller-specific checks. The shared
-- S15 rules: request id reuse, rate limits, capacity under the pool lock. Returns the outcome and the
-- new or retried file.
create function private.open_pet_upload(
  p_user_id uuid, p_home_id uuid, p_purpose text, p_content_type text, p_size bigint, p_request_id uuid,
  p_pet_id uuid, p_entry_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
  begin
    v_pool := private.lock_storage_pool(null, p_home_id);
    select * into v_existing from private.stored_files f
      where f.created_by = p_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = p_purpose and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now()
         and (exists (select 1 from private.pet_photo_uploads u
                where u.file_id = v_existing.id and u.pet_id = p_pet_id and p_entry_id is null)
           or exists (select 1 from private.pet_medical_attachment_uploads u
                where u.file_id = v_existing.id and u.entry_id = p_entry_id)) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.created_at > pg_catalog.now() - interval '1 hour')
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now())
         >= private.storage_limit('pending_per_account') then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    select * into v_usage from private.storage_usage(v_pool.id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
       > private.storage_allowance(v_pool) then
      return query select 'storage_full'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, p_purpose, p_user_id, p_request_id, private.new_object_key('h'),
      private.new_object_key('h'), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', p_purpose, 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- Pet photo ----------------------------------------------------------------------------------------------

-- Opens an upload of a pet's photo (pet manage). Outcomes: 'ok' (file id, upload key, expiry),
-- 'not_found', 'not_permitted', 'storage_full', 'rate_limited', 'conflict'. 22023 for an invalid type or
-- size.
create function public.create_pet_photo_intent(
  p_pet_id uuid, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_row record;
  begin
    if p_pet_id is null or p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('pet_photo')
       or not private.upload_type_allowed('pet_photo', p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null then
      return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if private.pet_access(v_pet.home_id, v_user_id) <> 'manage' then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select * into v_row from private.open_pet_upload(v_user_id, v_pet.home_id, 'pet_photo', p_content_type,
      p_size, p_request_id, v_pet.id, null);
    if v_row.outcome = 'ok' and not exists (
      select 1 from private.pet_photo_uploads u where u.file_id = v_row.file_id
    ) then
      insert into private.pet_photo_uploads (file_id, pet_id) values (v_row.file_id, v_pet.id);
    end if;
    return query select v_row.outcome, v_row.file_id, v_row.upload_key, v_row.expires_at;
  end
  $$;

-- Makes one of the caller's finished photo uploads the pet's photo, re-checking the pet and the
-- caller's right now. The previous photo is retired (recoverable by staff for the usual window, never
-- shown again). A retry answers 'saved' again. Outcomes: 'saved' (with the revision), 'not_found',
-- 'not_permitted'.
create function public.set_pet_photo(p_file_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_upload private.pet_photo_uploads;
    v_file private.stored_files;
    v_pet private.pets;
    v_old uuid;
  begin
    if p_file_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = v_user_id and f.purpose = 'pet_photo';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_upload from private.pet_photo_uploads u where u.file_id = p_file_id;
    if not found then
      -- A retry after it was applied.
      select * into v_pet from private.pets p where p.photo_file_id = p_file_id and p.deleted_at is null;
      if found and private.pet_access(v_pet.home_id, v_user_id) is not null then
        return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_pet.revision);
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_pet := private.lock_pet(v_upload.pet_id, v_user_id);
    if v_pet.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.pet_access(v_pet.home_id, v_user_id) <> 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_file.status <> 'ready' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_old := v_pet.photo_file_id;
    delete from private.pet_photo_uploads u where u.file_id = p_file_id;
    update private.pets p set photo_file_id = p_file_id, revision = p.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where p.id = v_pet.id
      returning * into v_pet;
    if v_old is not null and v_old <> p_file_id then
      perform private.retire_file(v_old);
    end if;
    perform private.audit_pet('pet.updated', v_pet.home_id, 'pet', v_pet.id,
      pg_catalog.jsonb_build_object('fields', pg_catalog.jsonb_build_array('photo_file_id')));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_pet.revision);
  end
  $$;

-- Removes the pet's photo (pet manage). Outcomes: 'saved', 'stale', 'not_found', 'not_permitted'.
create function public.remove_pet_photo(p_pet_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_old uuid;
  begin
    if p_pet_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.pet_access(v_pet.home_id, v_user_id) <> 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_pet.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_pet.revision);
    end if;
    if v_pet.photo_file_id is null then
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_pet.revision);
    end if;
    v_old := v_pet.photo_file_id;
    update private.pets p set photo_file_id = null, revision = p.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where p.id = v_pet.id
      returning * into v_pet;
    perform private.retire_file(v_old);
    perform private.audit_pet('pet.updated', v_pet.home_id, 'pet', v_pet.id,
      pg_catalog.jsonb_build_object('fields', pg_catalog.jsonb_build_array('photo_file_id')));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_pet.revision);
  end
  $$;

-- Medical attachments ------------------------------------------------------------------------------------

-- Attachments and uploads in progress on an entry.
create function private.pet_attachment_count(p_entry_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select (select count(*)::integer from private.pet_medical_attachments a
      where a.entry_id = p_entry_id and a.removed_at is null)
    + (select count(*)::integer from private.pet_medical_attachment_uploads u
      join private.stored_files f on f.id = u.file_id
      where u.entry_id = p_entry_id
        and (f.status = 'ready' or (f.status = 'pending' and f.expires_at > pg_catalog.now())));
  $$;

-- Opens an upload of an attachment for a medical entry (medical manage). Outcomes: 'ok', 'not_found'
-- (also without medical view), 'not_permitted', 'limit_reached', 'storage_full', 'rate_limited',
-- 'conflict'. 22023 for an invalid type, size or name.
create function public.create_pet_medical_attachment_intent(
  p_entry_id uuid, p_content_type text, p_size bigint, p_name text, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.pet_medical_entries;
    v_pet private.pets;
    v_row record;
  begin
    if p_entry_id is null or p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('pet_medical_attachment')
       or not private.upload_type_allowed('pet_medical_attachment', p_content_type)
       or p_name is null or not private.is_visible_name(p_name, private.pet_limit('attachment_name')) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    v_entry := private.lock_pet_medical_entry(p_entry_id, v_user_id);
    if v_entry.id is null then
      return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    -- A retry of the same request is answered by open_pet_upload before the count matters.
    if not exists (select 1 from private.stored_files f where f.created_by = v_user_id and f.request_id = p_request_id)
       and private.pet_attachment_count(v_entry.id) >= private.pet_limit('attachments') then
      return query select 'limit_reached'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select * into v_row from private.open_pet_upload(v_user_id, v_pet.home_id, 'pet_medical_attachment',
      p_content_type, p_size, p_request_id, null, v_entry.id);
    if v_row.outcome = 'ok' and not exists (
      select 1 from private.pet_medical_attachment_uploads u where u.file_id = v_row.file_id
    ) then
      insert into private.pet_medical_attachment_uploads (file_id, entry_id, display_name)
        values (v_row.file_id, v_entry.id, p_name);
    end if;
    return query select v_row.outcome, v_row.file_id, v_row.upload_key, v_row.expires_at;
  end
  $$;

-- Attaches one of the caller's finished uploads to the entry it was opened for, re-checking the entry
-- and the caller's medical access now. A retry answers 'attached' again without a second link.
-- Outcomes: 'attached' (with the attachment id), 'not_found', 'not_permitted', 'limit_reached'.
create function public.attach_pet_medical_file(p_file_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_upload private.pet_medical_attachment_uploads;
    v_file private.stored_files;
    v_entry private.pet_medical_entries;
    v_pet private.pets;
    v_link private.pet_medical_attachments;
  begin
    if p_file_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = v_user_id and f.purpose = 'pet_medical_attachment';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_upload from private.pet_medical_attachment_uploads u where u.file_id = p_file_id;
    if not found then
      select * into v_link from private.pet_medical_attachments a
        where a.file_id = p_file_id and a.added_by = v_user_id and a.removed_at is null;
      if found then
        v_entry := private.lock_pet_medical_entry(v_link.entry_id, v_user_id);
        if v_entry.id is not null then
          return pg_catalog.jsonb_build_object('outcome', 'attached', 'attachmentId', v_link.id);
        end if;
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_entry := private.lock_pet_medical_entry(v_upload.entry_id, v_user_id);
    if v_entry.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_file.status <> 'ready' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if (select count(*) from private.pet_medical_attachments a
        where a.entry_id = v_entry.id and a.removed_at is null) >= private.pet_limit('attachments') then
      return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
    end if;
    delete from private.pet_medical_attachment_uploads u where u.file_id = p_file_id;
    insert into private.pet_medical_attachments (entry_id, file_id, display_name, added_by)
      values (v_entry.id, p_file_id, v_upload.display_name, v_user_id)
      returning * into v_link;
    update private.pet_medical_entries e set updated_at = pg_catalog.now() where e.id = v_entry.id;
    perform private.audit_pet('pet.medical_attachment.added', v_pet.home_id, 'pet_medical_attachment', v_link.id,
      pg_catalog.jsonb_build_object('entryId', v_entry.id));
    return pg_catalog.jsonb_build_object('outcome', 'attached', 'attachmentId', v_link.id);
  end
  $$;

-- Moves an attachment to the Home's trash (medical manage). Outcomes: 'removed' (with the trash entry
-- id), 'not_found', 'not_permitted'.
create function public.remove_pet_medical_attachment(p_attachment_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_link private.pet_medical_attachments;
    v_entry private.pet_medical_entries;
    v_pet private.pets;
    v_trash uuid;
  begin
    if p_attachment_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_link from private.pet_medical_attachments a where a.id = p_attachment_id;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_entry := private.lock_pet_medical_entry(v_link.entry_id, v_user_id);
    select * into v_link from private.pet_medical_attachments a where a.id = p_attachment_id for update;
    if v_entry.id is null or v_link.removed_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_pet from private.pets p where p.id = v_entry.pet_id;
    if not private.pet_medical_can_manage(v_pet.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    update private.pet_medical_attachments a set removed_at = pg_catalog.now(), removed_by = v_user_id
      where a.id = v_link.id;
    update private.pet_medical_entries e set updated_at = pg_catalog.now() where e.id = v_entry.id;
    v_trash := private.trash_move(v_user_id, 'pets', 'pet_medical_attachment', v_link.id, null, v_pet.home_id,
      v_link.display_name, array[v_link.file_id]);
    perform private.audit_pet('pet.medical_attachment.removed', v_pet.home_id, 'pet_medical_attachment',
      v_link.id, pg_catalog.jsonb_build_object('entryId', v_entry.id));
    return pg_catalog.jsonb_build_object('outcome', 'removed', 'entryId', v_trash);
  end
  $$;

-- Reading files ------------------------------------------------------------------------------------------

-- The object behind a file the caller may see now, or no row (the same answer for every reason). As
-- before for avatars (S15), task attachments (S19c) and recipe covers (S24). Pet photos (S31): the
-- current photo of a pet in a Home the caller belongs to, or the caller's own upload not yet applied
-- (the editor's preview). Medical attachments (S31): an active attachment of an active entry of an
-- active pet, only with medical view in that Home now.
drop function public.authorize_file_read(uuid);
create function public.authorize_file_read(p_file_id uuid)
returns table (object_key text, content_type text, size_bytes bigint, sha256 text, display_name text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select f.object_key, f.content_type, f.size_bytes, f.sha256, null::text
      from private.stored_files f
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'avatar'
        and (
          f.created_by = v_user_id
          or exists (
            select 1
            from public.home_memberships owner_m
            join public.home_memberships viewer_m
              on viewer_m.home_id = owner_m.home_id and viewer_m.user_id = v_user_id
            left join public.home_member_profiles hp
              on hp.home_id = owner_m.home_id and hp.user_id = owner_m.user_id
            left join public.user_preferences up on up.user_id = owner_m.user_id
            where owner_m.user_id = f.created_by
              and coalesce(hp.avatar_file_id, up.avatar_file_id) = f.id
          )
        )
      union all
      select f.object_key, f.content_type, f.size_bytes, f.sha256, x.display_name
      from private.stored_files f,
        lateral (
          select a.display_name from private.task_attachments a
          join private.tasks t on t.id = a.task_id
          where a.file_id = f.id and a.removed_at is null and t.deleted_at is null
            and private.in_task_context(t.owner_user_id, t.owner_home_id, v_user_id)
          order by a.added_at, a.id
          limit 1
        ) x
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'task_attachment'
      union all
      select f.object_key, f.content_type, f.size_bytes, f.sha256, null::text
      from private.stored_files f
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'recipe_cover'
        and (
          exists (
            select 1 from private.recipes r
            where r.cover_file_id = f.id and private.can_see_recipe(r, v_user_id)
          )
          or exists (
            select 1 from private.recipe_cover_uploads u where u.file_id = f.id and u.user_id = v_user_id
          )
        )
      union all
      select f.object_key, f.content_type, f.size_bytes, f.sha256, null::text
      from private.stored_files f
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'pet_photo'
        and (
          exists (
            select 1 from private.pets p
            where p.photo_file_id = f.id and p.deleted_at is null
              and private.pet_access(p.home_id, v_user_id) is not null
          )
          or (f.created_by = v_user_id
            and exists (select 1 from private.pet_photo_uploads u where u.file_id = f.id))
        )
      union all
      select f.object_key, f.content_type, f.size_bytes, f.sha256, a.display_name
      from private.stored_files f
      join private.pet_medical_attachments a on a.file_id = f.id and a.removed_at is null
      join private.pet_medical_entries e on e.id = a.entry_id and e.deleted_at is null
      join private.pets p on p.id = e.pet_id and p.deleted_at is null
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'pet_medical_attachment'
        and private.pet_medical_can_view(p.home_id, v_user_id);
  end
  $$;

-- storage-upload-expire (S15) also retires a finished pet upload nobody applied, and forgets the upload
-- of one that failed or expired.
alter function public.expire_upload(uuid) rename to expire_upload_before_pets;
alter function public.expire_upload_before_pets(uuid) set schema private;

create function public.expire_upload(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_status text := private.expire_upload_before_pets(p_file_id);
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found or v_file.purpose not in ('pet_photo', 'pet_medical_attachment') then
      return v_status;
    end if;
    if v_file.status = 'failed' then
      delete from private.pet_photo_uploads u where u.file_id = v_file.id;
      delete from private.pet_medical_attachment_uploads u where u.file_id = v_file.id;
    elsif v_file.status = 'ready' and (
      exists (select 1 from private.pet_photo_uploads u where u.file_id = v_file.id)
      or exists (select 1 from private.pet_medical_attachment_uploads u where u.file_id = v_file.id)
    ) then
      perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
      delete from private.pet_photo_uploads u where u.file_id = v_file.id;
      delete from private.pet_medical_attachment_uploads u where u.file_id = v_file.id;
      if not exists (select 1 from private.pets p where p.photo_file_id = v_file.id)
         and not exists (select 1 from private.pet_medical_attachments a where a.file_id = v_file.id) then
        perform private.retire_file(v_file.id);
      end if;
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    return v_file.status;
  end
  $$;

-- Medical access ----------------------------------------------------------------------------------------

-- Who has medical access in a Home. Someone who may grant it (the Owner, Administrators granted
-- managePetMedicalAccess) sees every member with their level; everyone else only their own. 42501 for a
-- Home the caller is not in.
create function public.list_pet_medical_access(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_grantor boolean;
  begin
    perform private.require_pet_home(p_home_id, v_user_id);
    v_grantor := private.has_home_capability(p_home_id, v_user_id, 'managePetMedicalAccess');
    return pg_catalog.jsonb_build_object(
      'canGrant', v_grantor,
      'members', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'membershipId', m.id,
            'isSelf', m.user_id = v_user_id,
            'role', m.role,
            'level', coalesce(private.pet_medical_level(p_home_id, m.user_id), 'none'),
            'canChange', v_grantor and m.user_id <> v_user_id and m.role <> 'owner')
          order by m.created_at, m.id)
        from public.home_memberships m
        where m.home_id = p_home_id and (v_grantor or m.user_id = v_user_id)), '[]'::jsonb)
    );
  end
  $$;

-- Sets a member's medical access: 'none', 'view' or 'manage'. Only the Owner and Administrators
-- granted managePetMedicalAccess, never for themselves or the Owner. Works at once. Outcomes: 'ok',
-- 'unchanged', 'not_found', 'not_permitted'. 42501 for a Home the caller is not in.
create function public.set_pet_medical_access(p_home_id uuid, p_membership_id uuid, p_level text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_before text;
  begin
    if p_membership_id is null or p_level is null or p_level not in ('none', 'view', 'manage') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.require_pet_home(p_home_id, v_user_id);
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if not private.has_home_capability(p_home_id, v_user_id, 'managePetMedicalAccess') then
      return 'not_permitted';
    end if;
    select * into v_target from public.home_memberships m where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner' then
      return 'not_permitted';
    end if;
    v_before := coalesce(private.pet_medical_level(p_home_id, v_target.user_id), 'none');
    if v_before = p_level then
      return 'unchanged';
    end if;
    if p_level = 'none' then
      delete from private.pet_medical_access a where a.home_id = p_home_id and a.user_id = v_target.user_id;
    else
      insert into private.pet_medical_access (home_id, user_id, level, granted_by)
        values (p_home_id, v_target.user_id, p_level, v_user_id)
        on conflict (home_id, user_id) do update
          set level = excluded.level, granted_by = excluded.granted_by, granted_at = pg_catalog.now();
    end if;
    perform private.audit('pet.medical_access.changed', p_home_id, 'user', v_target.user_id,
      pg_catalog.jsonb_build_object('from', v_before, 'to', p_level));
    return 'ok';
  end
  $$;

-- Trash --------------------------------------------------------------------------------------------------

-- The pets module's own rule (S16 lets a module set it for its item types): a pet's trash entry is for
-- people who manage pets and medical information (Ward, 2026-11-04: restoring or purging a pet brings
-- back or destroys its medical records), for every pet, so the rule never tells whether a pet has any;
-- a medical entry's or attachment's only for medical managers, so nobody else learns that it exists,
-- not even from the trash list or its count. Rechecked on every list, restore and purge, so a revoked
-- grant hides it at once.
alter function private.can_see_trash_entry(private.trash_entries, uuid) rename to can_see_trash_entry_before_pets;

create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select case
    when p_entry.module <> 'pets' then private.can_see_trash_entry_before_pets(p_entry, p_user_id)
    when p_user_id is null or p_entry.owner_home_id is null then false
    when p_entry.item_type = 'pet' then
      coalesce(private.pet_access(p_entry.owner_home_id, p_user_id) = 'manage', false)
        and private.pet_medical_can_manage(p_entry.owner_home_id, p_user_id)
    else private.pet_medical_can_manage(p_entry.owner_home_id, p_user_id)
  end;
  $$;

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_pets;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_pets;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_pets;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_pets;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_pets;

-- A pet's only conflict: the Home already has 50 ('pet_limit'). A medical entry's: its pet is in the
-- trash ('pet_in_trash'; restore the pet first) or the pet has 1000 entries ('entry_limit'). An
-- attachment's: its entry or pet is in the trash ('entry_in_trash') or the entry has 10 ('pet_attachment_limit').
-- None can be resolved from the trash; the person makes room or restores the parent first.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_pet private.pets;
    v_entry private.pet_medical_entries;
    v_link private.pet_medical_attachments;
  begin
    if p_entry.module <> 'pets' then
      return private.trash_conflict_before_pets(p_entry);
    end if;
    case p_entry.item_type
      when 'pet' then
        select * into v_pet from private.pets p where p.id = p_entry.subject_id;
        if not found or v_pet.deleted_at is null then
          return 'item_missing';
        end if;
        if private.pet_home_full(v_pet.home_id) then
          return 'pet_limit';
        end if;
      when 'pet_medical_entry' then
        select * into v_entry from private.pet_medical_entries e where e.id = p_entry.subject_id;
        if not found or v_entry.deleted_at is null then
          return 'item_missing';
        end if;
        if exists (select 1 from private.pets p where p.id = v_entry.pet_id and p.deleted_at is not null) then
          return 'pet_in_trash';
        end if;
        if (select count(*) from private.pet_medical_entries e
            where e.pet_id = v_entry.pet_id and e.deleted_at is null) >= private.pet_limit('entries') then
          return 'entry_limit';
        end if;
      when 'pet_medical_attachment' then
        select * into v_link from private.pet_medical_attachments a where a.id = p_entry.subject_id;
        if not found or v_link.removed_at is null then
          return 'item_missing';
        end if;
        if exists (
          select 1 from private.pet_medical_entries e join private.pets p on p.id = e.pet_id
          where e.id = v_link.entry_id and (e.deleted_at is not null or p.deleted_at is not null)
        ) then
          return 'entry_in_trash';
        end if;
        if (select count(*) from private.pet_medical_attachments a
            where a.entry_id = v_link.entry_id and a.removed_at is null) >= private.pet_limit('attachments') then
          return 'pet_attachment_limit';
        end if;
      else
        return 'item_missing';
    end case;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case
    when p_kind in ('pet_limit', 'pet_in_trash', 'entry_limit', 'entry_in_trash', 'pet_attachment_limit')
      then array[]::text[]
    else private.trash_conflict_options_before_pets(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'pets' then
      perform private.trash_resolve_before_pets(p_entry, p_resolution);
    end if;
    -- Pets have no resolvable conflict.
  end
  $$;

-- The item comes back as it was deleted, with the files that went with it while they are still
-- recoverable; a photo or attachment whose file is gone is dropped and reported.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
    v_lost integer := 0;
    v_pet_id uuid;
  begin
    if p_entry.module <> 'pets' then
      return private.trash_item_restore_before_pets(p_entry);
    end if;
    case p_entry.item_type
      when 'pet' then
        select p.id into v_pet_id from private.pets p
          where p.id = p_entry.subject_id and p.deleted_at is not null for update;
        if v_pet_id is null then
          raise exception 'pet unavailable' using errcode = '23505';
        end if;
        perform private.lock_pet_home(p_entry.owner_home_id);
        if private.pet_home_full(p_entry.owner_home_id) then
          raise exception 'pet limit' using errcode = '23505';
        end if;
      when 'pet_medical_entry' then
        select e.pet_id into v_pet_id from private.pet_medical_entries e
          where e.id = p_entry.subject_id and e.deleted_at is not null;
        if v_pet_id is null then
          raise exception 'entry unavailable' using errcode = '23505';
        end if;
        perform 1 from private.pets p where p.id = v_pet_id for update;
        perform 1 from private.pet_medical_entries e where e.id = p_entry.subject_id for update;
      when 'pet_medical_attachment' then
        select e.pet_id into v_pet_id from private.pet_medical_attachments a
          join private.pet_medical_entries e on e.id = a.entry_id
          where a.id = p_entry.subject_id and a.removed_at is not null;
        if v_pet_id is null then
          raise exception 'attachment unavailable' using errcode = '23505';
        end if;
        perform 1 from private.pets p where p.id = v_pet_id for update;
    end case;
    -- The conflict check again, under the locks.
    if private.trash_conflict(p_entry) is not null then
      raise exception 'pets restore conflict' using errcode = '23505';
    end if;
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
    loop
      if not private.restore_file(v_file_id) then
        -- The file is gone for good: what pointed to it goes too, so nothing shows a missing file.
        v_lost := v_lost + 1;
        update private.pets p set photo_file_id = null where p.photo_file_id = v_file_id;
        delete from private.pet_medical_attachments a where a.file_id = v_file_id;
      end if;
    end loop;
    -- A pet's medical documents: a lost one goes silently, so the answer counts no medical files.
    for v_file_id in
      select pf.file_id from private.pet_trash_files pf where pf.entry_id = p_entry.id order by pf.file_id
    loop
      if not private.restore_file(v_file_id) then
        delete from private.pet_medical_attachments a where a.file_id = v_file_id;
      end if;
    end loop;
    delete from private.pet_trash_files pf where pf.entry_id = p_entry.id;
    case p_entry.item_type
      when 'pet' then
        update private.pets p set deleted_at = null, revision = p.revision + 1, updated_at = pg_catalog.now()
          where p.id = p_entry.subject_id;
        perform private.audit_pet('pet.restored', p_entry.owner_home_id, 'pet', p_entry.subject_id);
      when 'pet_medical_entry' then
        update private.pet_medical_entries e set deleted_at = null, revision = e.revision + 1,
            updated_at = pg_catalog.now()
          where e.id = p_entry.subject_id;
        perform private.audit_pet('pet.medical_entry.restored', p_entry.owner_home_id, 'pet_medical_entry',
          p_entry.subject_id);
      when 'pet_medical_attachment' then
        -- Only when its file came back (otherwise the row is already gone).
        update private.pet_medical_attachments a set removed_at = null, removed_by = null
          where a.id = p_entry.subject_id;
        perform private.audit_pet('pet.medical_attachment.restored', p_entry.owner_home_id,
          'pet_medical_attachment', p_entry.subject_id);
    end case;
    return v_lost;
  end
  $$;

-- Removes the item for good with its files. Purging a pet also settles the open trash entries of its
-- own medical entries and attachments, so nothing is left that could never be restored.
create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
    v_other uuid;
  begin
    if p_entry.module <> 'pets' then
      perform private.trash_item_purge_before_pets(p_entry);
      return;
    end if;
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
    loop
      perform private.purge_file_now(v_file_id);
    end loop;
    for v_file_id in
      select pf.file_id from private.pet_trash_files pf where pf.entry_id = p_entry.id order by pf.file_id
    loop
      perform private.purge_file_now(v_file_id);
    end loop;
    delete from private.pet_trash_files pf where pf.entry_id = p_entry.id;
    case p_entry.item_type
      when 'pet' then
        for v_other in
          select t.id from private.trash_entries t
          where t.status = 'trashed' and t.owner_home_id = p_entry.owner_home_id and t.module = 'pets'
            and ((t.item_type = 'pet_medical_entry' and t.subject_id in (
                  select e.id from private.pet_medical_entries e where e.pet_id = p_entry.subject_id))
              or (t.item_type = 'pet_medical_attachment' and t.subject_id in (
                  select a.id from private.pet_medical_attachments a
                  join private.pet_medical_entries e on e.id = a.entry_id
                  where e.pet_id = p_entry.subject_id)))
          order by t.id
        loop
          perform private.trash_purge_one(null, v_other);
        end loop;
        delete from private.pets p where p.id = p_entry.subject_id and p.deleted_at is not null;
      when 'pet_medical_entry' then
        for v_other in
          select t.id from private.trash_entries t
          where t.status = 'trashed' and t.item_type = 'pet_medical_attachment' and t.subject_id in (
            select a.id from private.pet_medical_attachments a where a.entry_id = p_entry.subject_id)
          order by t.id
        loop
          perform private.trash_purge_one(null, v_other);
        end loop;
        delete from private.pet_medical_entries e where e.id = p_entry.subject_id and e.deleted_at is not null;
      when 'pet_medical_attachment' then
        delete from private.pet_medical_attachments a where a.id = p_entry.subject_id and a.removed_at is not null;
    end case;
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The pets API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'list_pets', 'get_pet', 'get_pet_medical', 'get_pet_medical_entry', 'create_pet', 'update_pet',
      'delete_pet', 'set_pet_medical_details', 'create_pet_medical_entry', 'update_pet_medical_entry',
      'delete_pet_medical_entry', 'create_pet_photo_intent', 'set_pet_photo', 'remove_pet_photo',
      'create_pet_medical_attachment_intent', 'attach_pet_medical_file', 'remove_pet_medical_attachment',
      'list_pet_medical_access', 'set_pet_medical_access', 'authorize_file_read'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The upload expiry job: the service role only.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'expire_upload'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%pet%'
      or p.proname in ('can_see_trash_entry', 'trash_conflict', 'trash_conflict_options', 'trash_resolve',
        'trash_item_restore', 'trash_item_purge', 'upload_max_bytes', 'upload_type_allowed',
        'stored_type_allowed', 'is_delegable_capability')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
