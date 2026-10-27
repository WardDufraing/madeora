-- S24: recipes core (brief plans/steps/S24-brief.md; ADR 0031; spec "Confirmed private recipe drafts
-- and explicit publishing", "Confirmed latest-only recipe content without version history",
-- "Confirmed exclusive recipe editing locks", "Confirmed context-owned canonical recipes and
-- membership departure", "Confirmed configurable recipe dashboard widgets", "Confirmed single cover
-- photo per recipe", "Confirmed step-by-step recipe cooking mode", "Confirmed optional personal
-- recipe ratings", "Confirmed recipe search, tags, favorites and sorting", "Confirmed recipe
-- serving-size scaling", "Confirmed structured everyday recipe fields").
--
-- One canonical row per recipe, owned by exactly one context: a person (their Personal space) or a
-- Home. The creator is kept for attribution only. A draft always belongs to its creator's Personal
-- space, whatever Home it is meant for (draft_home_id is only the intended destination): no query of
-- a Home can return a draft, so draft privacy holds by construction. Publishing moves the recipe into
-- its destination.
--
-- Nothing here is exposed as a table; people use security-definer functions that run with their own
-- session and recheck the confirmed caller, their current membership and their rights on every
-- call. A Home the caller is not in answers 42501 "not permitted" exactly like one that does not
-- exist; a recipe they may not see answers 'not_found' (or null) exactly like a missing one.
--
-- Who may do what (default picked in the brief, owner may override; the per-module permission matrix
-- is open in the spec). packages/domain/src/permissions/recipes.ts makes the same decisions:
-- - A draft: its creator only, for everything. Nobody else, Home managers and the Owner included.
-- - Personal space: its owner, for everything.
-- - Home: every current member views, searches, rates, favorites and publishes recipes into it; the
--   recipe's creator while a member, and recipe managers (the Owner, Administrators granted the new
--   delegable capability manageHomeRecipes), edit it under the exclusive lock and delete it.
--
-- Content is latest-only: a save replaces it, and `revision` is a concurrency token, not a history.
-- Published recipes are edited under an exclusive, short-lived lock (one row per recipe, taken
-- atomically, renewed by heartbeats); a save rechecks the lock, the revision and the right to edit
-- in one transaction. Drafts are edited by their creator alone and protected by the revision only.
--
-- Lock order, to avoid deadlocks with a member leaving: the Home row and the membership (for key
-- share) first, then the recipe row, then its lock row, then storage pools. Leaving or removal locks
-- the Home row first too, so the two never wait on each other in opposite orders.

-- Audit subjects, the new capability, trash types, file purpose ---------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe'
  ));

alter table private.stored_files drop constraint stored_files_purpose_check;
alter table private.stored_files add constraint stored_files_purpose_check
  check (purpose in ('avatar', 'task_attachment', 'recipe_cover'));

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/recipes/schema.ts and packages/domain/src/recipes use the same numbers.
create function private.recipe_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'recipes' then 2000           -- non-deleted recipes per context (drafts count as personal)
    when 'name' then 200
    when 'ingredients' then 100
    when 'ingredient_name' then 200
    when 'ingredient_note' then 200
    when 'steps' then 100
    when 'step' then 2000
    when 'notes' then 5000
    when 'tags' then 20
    when 'tag' then 40
    when 'servings_label' then 40
    when 'max_servings' then 999
    when 'max_minutes' then 10080      -- seven days
    when 'max_quantity' then 100000
    when 'max_denominator' then 1000
    when 'page' then 24
    when 'max_offset' then 10000
    when 'query' then 100
    when 'lock_seconds' then 120       -- a lock lasts this long after its last heartbeat
    when 'widget' then 5
  end;
  $$;

-- What two texts compare as for search, tags and sorting: compatibility-normalized, accents removed,
-- lower case, runs of whitespace as one space (spec: "forgiving case/diacritic handling").
create function private.recipe_fold(p_text text) returns text
  language sql immutable strict set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.normalize(pg_catalog.normalize(p_text, 'NFKC'), 'NFD'), '[\u0300-\u036f]', '', 'g')),
    '\s+', ' ', 'g'));
  $$;

-- The supported units (packages/domain recipeUnits). Anything else belongs in the ingredient's note.
create function private.is_recipe_unit(p_unit text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_unit in (
    'g', 'kg', 'mg', 'ml', 'cl', 'dl', 'l', 'tsp', 'tbsp', 'cup', 'fl_oz', 'oz', 'lb', 'piece',
    'pinch', 'clove', 'slice', 'can', 'jar', 'pack', 'bunch', 'sprig', 'handful'
  ), false);
  $$;

-- Tables -------------------------------------------------------------------------------------------

create table private.recipes (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  status text not null constraint recipes_status_check check (status in ('draft', 'published')),
  -- A draft's intended destination (null: the Personal space). Cleared, and flagged, when the
  -- creator stops being a member of that Home or it is deleted.
  draft_home_id uuid references public.homes (id) on delete set null,
  destination_lost boolean not null default false,
  -- A draft may have no name yet; a published recipe always has one (recipes_published_check).
  name text constraint recipes_name_check check (name is null or private.is_visible_name(name, 200)),
  name_key text,
  servings integer constraint recipes_servings_check check (servings between 1 and 999),
  servings_label text
    constraint recipes_servings_label_check check (servings_label is null or private.is_visible_name(servings_label, 40)),
  prep_minutes integer constraint recipes_prep_check check (prep_minutes between 0 and 10080),
  cook_minutes integer constraint recipes_cook_check check (cook_minutes between 0 and 10080),
  notes text constraint recipes_notes_check check (notes is null or private.is_plain_text(notes, 5000)),
  tags text[] not null default '{}' constraint recipes_tags_check check (cardinality(tags) <= 20),
  -- The folded tags, for filtering (private.recipe_fold of each, same order).
  tag_keys text[] not null default '{}',
  cover_file_id uuid references private.stored_files (id) on delete set null,
  -- Concurrency token only (latest-only content): never a way back to older content.
  revision integer not null default 1 constraint recipes_revision_check check (revision >= 1),
  -- A client publish id, so a repeated or doubled publish answers instead of publishing twice.
  publish_request_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- The last substantive edit (content saves only; never views, ratings or favorites).
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  -- When it was published: the "date added" of the library.
  published_at timestamptz,
  deleted_at timestamptz,
  constraint recipes_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  -- A draft is always its creator's own.
  constraint recipes_draft_personal check (
    status <> 'draft' or (owner_user_id is not null and owner_home_id is null)
  ),
  constraint recipes_draft_destination check (status = 'draft' or (draft_home_id is null and not destination_lost)),
  constraint recipes_published_check check (
    status <> 'published' or (name is not null and published_at is not null)
  )
);

create index recipes_home_idx on private.recipes (owner_home_id, published_at desc)
  where deleted_at is null and owner_home_id is not null;
create index recipes_user_idx on private.recipes (owner_user_id, status, published_at desc)
  where deleted_at is null and owner_user_id is not null;
create index recipes_draft_home_idx on private.recipes (draft_home_id) where draft_home_id is not null;
create index recipes_cover_idx on private.recipes (cover_file_id) where cover_file_id is not null;

create table private.recipe_ingredients (
  recipe_id uuid not null references private.recipes (id) on delete cascade,
  position integer not null constraint recipe_ingredients_position_check check (position between 0 and 99),
  name text not null constraint recipe_ingredients_name_check check (private.is_visible_name(name, 200)),
  name_key text not null,
  -- An exact positive fraction and how it was typed; all three or none.
  quantity_num bigint,
  quantity_den integer,
  quantity_style text constraint recipe_ingredients_style_check check (quantity_style in ('decimal', 'fraction')),
  unit text constraint recipe_ingredients_unit_check check (unit is null or private.is_recipe_unit(unit)),
  note text constraint recipe_ingredients_note_check check (note is null or private.is_visible_name(note, 200)),
  primary key (recipe_id, position),
  constraint recipe_ingredients_quantity_check check (
    (quantity_num is null and quantity_den is null and quantity_style is null)
    or (
      quantity_num > 0 and quantity_den between 1 and 1000
      and quantity_num <= 100000::bigint * quantity_den
      and pg_catalog.gcd(quantity_num, quantity_den::bigint) = 1
      -- A decimal value has at most three decimals.
      and (quantity_style = 'fraction' or 1000 % quantity_den = 0)
    )
  )
);

create table private.recipe_steps (
  recipe_id uuid not null references private.recipes (id) on delete cascade,
  position integer not null constraint recipe_steps_position_check check (position between 0 and 99),
  body text not null constraint recipe_steps_body_check check (private.is_plain_text(body, 2000)),
  primary key (recipe_id, position)
);

-- One editor at a time per canonical recipe. The token names one edit session (one tab), so the
-- same person on two devices is told, and saves only from the session that holds it.
create table private.recipe_edit_locks (
  recipe_id uuid primary key references private.recipes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  token uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index recipe_edit_locks_user_idx on private.recipe_edit_locks (user_id);

-- Per member and per context (spec: favorites are personal and context-local; S25 adds shared
-- recipes seen from another Home). context_home_id null: the Personal space.
create table private.recipe_favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid not null references private.recipes (id) on delete cascade,
  context_home_id uuid references public.homes (id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index recipe_favorites_key on private.recipe_favorites
  (user_id, recipe_id, coalesce(context_home_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index recipe_favorites_recipe_idx on private.recipe_favorites (recipe_id);

-- One current rating per member and recipe. Rows of people who left stay, but only current members
-- of the context count (private.recipe_rating).
create table private.recipe_ratings (
  recipe_id uuid not null references private.recipes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null constraint recipe_ratings_stars_check check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (recipe_id, user_id)
);

-- A cover upload not yet saved into a recipe: who opened it and for which recipe (null: a recipe
-- that does not exist yet). Gone once a save adopts it; the expiry job retires the rest.
create table private.recipe_cover_uploads (
  file_id uuid primary key references private.stored_files (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid references private.recipes (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index recipe_cover_uploads_user_idx on private.recipe_cover_uploads (user_id);

comment on table private.recipes is 'S24: canonical recipes and private drafts. Not exposed through the API.';
comment on table private.recipe_ingredients is 'S24: ordered recipe ingredients. Not exposed through the API.';
comment on table private.recipe_steps is 'S24: ordered recipe steps. Not exposed through the API.';
comment on table private.recipe_edit_locks is 'S24: exclusive recipe editing locks. Not exposed through the API.';
comment on table private.recipe_favorites is 'S24: personal, context-local recipe favorites. Not exposed through the API.';
comment on table private.recipe_ratings is 'S24: personal 1-5 star recipe ratings. Not exposed through the API.';
comment on table private.recipe_cover_uploads is 'S24: cover uploads awaiting a save. Not exposed through the API.';

alter table private.recipes enable row level security;
alter table private.recipe_ingredients enable row level security;
alter table private.recipe_steps enable row level security;
alter table private.recipe_edit_locks enable row level security;
alter table private.recipe_favorites enable row level security;
alter table private.recipe_ratings enable row level security;
alter table private.recipe_cover_uploads enable row level security;
revoke all on private.recipes, private.recipe_ingredients, private.recipe_steps,
  private.recipe_edit_locks, private.recipe_favorites, private.recipe_ratings,
  private.recipe_cover_uploads
  from public, anon, authenticated, service_role;

-- Permission helpers (the engine in packages/domain mirrors these) ----------------------------------

-- Recipe managers: the Personal space's owner; in a Home the Owner and Administrators granted
-- manageHomeRecipes (engine action home.recipes.manage).
create function private.can_manage_recipes(p_owner_user_id uuid, p_owner_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (p_owner_home_id is not null
      and private.has_home_capability(p_owner_home_id, p_user_id, 'manageHomeRecipes'))
  );
  $$;

-- Whether p_user_id may see the recipe now: a draft only its creator (who owns it); a published
-- recipe its Personal space's owner or a current member of its Home. Never a deleted one.
create function private.can_see_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  -- Every term is false, never null, when it does not hold.
  select p_user_id is not null and p_recipe.id is not null and p_recipe.deleted_at is null and (
    coalesce(p_recipe.owner_user_id = p_user_id, false)
    or (p_recipe.status = 'published' and p_recipe.owner_home_id is not null
      and private.is_home_member(p_recipe.owner_home_id, p_user_id))
  );
  $$;

-- Edit (under the lock) and delete: a draft's creator; a recipe manager; or the current member of the
-- recipe's Home who created it.
create function private.can_edit_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.can_see_recipe(p_recipe, p_user_id) and (
    private.can_manage_recipes(p_recipe.owner_user_id, p_recipe.owner_home_id, p_user_id)
    or (p_recipe.owner_home_id is not null and coalesce(p_recipe.created_by = p_user_id, false))
  );
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_recipe_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Holds the Home and the caller's membership of it for the rest of the transaction (key share), so
-- a departure (which locks the Home row first, then deletes the membership) waits for a save or
-- publish already under way and never interleaves with it. Taken before any recipe row (see the
-- lock order above). False when they are not a member.
create function private.hold_membership(p_home_id uuid, p_user_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_home_id is null then
      return true;
    end if;
    perform 1 from public.homes h where h.id = p_home_id for key share;
    perform 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = p_user_id for key share;
    return found;
  end
  $$;

create function private.audit_recipe(
  p_action text, p_home_id uuid, p_recipe_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids and counts only: never names, ingredients, steps or notes (latest-only content: no old
  -- content is kept anywhere, the audit included). Home actions only.
  select case when p_home_id is not null
    then private.audit(p_action, p_home_id, 'recipe', p_recipe_id, p_details) end;
  $$;

-- The average and count of the ratings that count for a recipe now: those of current members of its
-- Home (Personal: only its owner's). Never individual ratings.
create function private.recipe_rating(p_recipe_id uuid, p_owner_user_id uuid, p_owner_home_id uuid)
returns table (average numeric, rating_count integer)
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.round(avg(r.stars), 2), count(*)::integer
  from private.recipe_ratings r
  where r.recipe_id = p_recipe_id
    and (coalesce(r.user_id = p_owner_user_id, false)
      or (p_owner_home_id is not null and exists (
        select 1 from public.home_memberships m
        where m.home_id = p_owner_home_id and m.user_id = r.user_id)));
  $$;

-- Member departure ------------------------------------------------------------------------------------

-- Before a membership ends: the person's editing locks on that Home's recipes end at once (a later
-- save is refused), and their drafts meant for that Home lose the destination, flagged, so My
-- drafts asks them to choose another. Recipes stay with the Home (spec "Confirmed context-owned
-- canonical recipes and membership departure").
create function private.recipes_member_left() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.recipe_edit_locks l
      using private.recipes r
      where l.recipe_id = r.id and l.user_id = old.user_id and r.owner_home_id = old.home_id;
    update private.recipes r set draft_home_id = null, destination_lost = true
      where r.status = 'draft' and r.owner_user_id = old.user_id and r.draft_home_id = old.home_id;
    return old;
  end
  $$;

create trigger home_memberships_recipes before delete on public.home_memberships
  for each row execute function private.recipes_member_left();

-- Content: validating and writing ------------------------------------------------------------------

-- The content a save sends, as one JSON object (every key present; null where empty):
--   { "name": text|null, "servings": int|null, "servingsLabel": text|null,
--     "prepMinutes": int|null, "cookMinutes": int|null, "notes": text|null, "tags": [text],
--     "ingredients": [{ "name": text, "quantity": {"num": int, "den": int, "style": text}|null,
--                       "unit": text|null, "note": text|null }],
--     "steps": [text], "coverFileId": uuid|null }
-- Whether it is well formed and within every limit (22023 otherwise, from the callers). A draft may be
-- incomplete; the published minimum is checked apart (private.recipe_is_complete).
create function private.valid_recipe_content(p jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
  declare
    v_item jsonb;
    v_quantity jsonb;
    v_num numeric;
    v_den numeric;
    v_keys text[] := '{}';
    v_key text;
  begin
    if p is null or pg_catalog.jsonb_typeof(p) <> 'object'
       or not (p ?& array['name', 'servings', 'servingsLabel', 'prepMinutes', 'cookMinutes', 'notes',
         'tags', 'ingredients', 'steps', 'coverFileId']) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p -> 'name') <> 'null'
       and (pg_catalog.jsonb_typeof(p -> 'name') <> 'string'
         or not private.is_visible_name(p ->> 'name', private.recipe_limit('name'))) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p -> 'servings') <> 'null'
       and (pg_catalog.jsonb_typeof(p -> 'servings') <> 'number'
         or (p ->> 'servings') !~ '^[0-9]{1,3}$'
         or (p ->> 'servings')::integer not between 1 and private.recipe_limit('max_servings')) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p -> 'servingsLabel') <> 'null'
       and (pg_catalog.jsonb_typeof(p -> 'servingsLabel') <> 'string'
         or not private.is_visible_name(p ->> 'servingsLabel', private.recipe_limit('servings_label'))) then
      return false;
    end if;
    foreach v_key in array array['prepMinutes', 'cookMinutes'] loop
      if pg_catalog.jsonb_typeof(p -> v_key) <> 'null'
         and (pg_catalog.jsonb_typeof(p -> v_key) <> 'number'
           or (p ->> v_key) !~ '^[0-9]{1,5}$'
           or (p ->> v_key)::integer > private.recipe_limit('max_minutes')) then
        return false;
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(p -> 'notes') <> 'null'
       and (pg_catalog.jsonb_typeof(p -> 'notes') <> 'string'
         or not private.is_plain_text(p ->> 'notes', private.recipe_limit('notes'))) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p -> 'coverFileId') <> 'null'
       and (pg_catalog.jsonb_typeof(p -> 'coverFileId') <> 'string'
         or (p ->> 'coverFileId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      return false;
    end if;

    if pg_catalog.jsonb_typeof(p -> 'tags') <> 'array'
       or pg_catalog.jsonb_array_length(p -> 'tags') > private.recipe_limit('tags') then
      return false;
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(p -> 'tags') loop
      if pg_catalog.jsonb_typeof(v_item) <> 'string'
         or not private.is_visible_name(v_item #>> '{}', private.recipe_limit('tag')) then
        return false;
      end if;
      -- The same tag twice (whatever its case or accents) is a mistake, not two tags.
      v_key := private.recipe_fold(v_item #>> '{}');
      if v_key = any (v_keys) then
        return false;
      end if;
      v_keys := v_keys || v_key;
    end loop;

    if pg_catalog.jsonb_typeof(p -> 'steps') <> 'array'
       or pg_catalog.jsonb_array_length(p -> 'steps') > private.recipe_limit('steps') then
      return false;
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(p -> 'steps') loop
      if pg_catalog.jsonb_typeof(v_item) <> 'string'
         or not private.is_plain_text(v_item #>> '{}', private.recipe_limit('step')) then
        return false;
      end if;
    end loop;

    if pg_catalog.jsonb_typeof(p -> 'ingredients') <> 'array'
       or pg_catalog.jsonb_array_length(p -> 'ingredients') > private.recipe_limit('ingredients') then
      return false;
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(p -> 'ingredients') loop
      if pg_catalog.jsonb_typeof(v_item) <> 'object'
         or not (v_item ?& array['name', 'quantity', 'unit', 'note'])
         or pg_catalog.jsonb_typeof(v_item -> 'name') <> 'string'
         or not private.is_visible_name(v_item ->> 'name', private.recipe_limit('ingredient_name')) then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'unit') <> 'null'
         and (pg_catalog.jsonb_typeof(v_item -> 'unit') <> 'string'
           or not private.is_recipe_unit(v_item ->> 'unit')) then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'note') <> 'null'
         and (pg_catalog.jsonb_typeof(v_item -> 'note') <> 'string'
           or not private.is_visible_name(v_item ->> 'note', private.recipe_limit('ingredient_note'))) then
        return false;
      end if;
      v_quantity := v_item -> 'quantity';
      if pg_catalog.jsonb_typeof(v_quantity) <> 'null' then
        if pg_catalog.jsonb_typeof(v_quantity) <> 'object'
           or pg_catalog.jsonb_typeof(v_quantity -> 'num') <> 'number'
           or pg_catalog.jsonb_typeof(v_quantity -> 'den') <> 'number'
           or (v_quantity ->> 'num') !~ '^[0-9]{1,9}$' or (v_quantity ->> 'den') !~ '^[0-9]{1,4}$'
           or coalesce(v_quantity ->> 'style', '') not in ('decimal', 'fraction') then
          return false;
        end if;
        v_num := (v_quantity ->> 'num')::numeric;
        v_den := (v_quantity ->> 'den')::numeric;
        if v_num < 1 or v_den not between 1 and private.recipe_limit('max_denominator')
           or v_num > private.recipe_limit('max_quantity') * v_den
           or pg_catalog.gcd(v_num, v_den) <> 1
           or (v_quantity ->> 'style' = 'decimal' and 1000 % v_den <> 0) then
          return false;
        end if;
      end if;
    end loop;
    return true;
  end
  $$;

-- The published minimum (spec): a name and at least one ingredient or step.
create function private.recipe_is_complete(p_recipe_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.recipes r where r.id = p_recipe_id and r.name is not null)
    and (exists (select 1 from private.recipe_ingredients i where i.recipe_id = p_recipe_id)
      or exists (select 1 from private.recipe_steps s where s.recipe_id = p_recipe_id));
  $$;

-- Replaces a recipe's content with p (already validated). Latest-only: nothing of the previous
-- content is kept. The cover is handled apart (private.adopt_recipe_cover).
create function private.write_recipe_content(p_recipe_id uuid, p jsonb, p_user_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.recipes r set
        name = p ->> 'name',
        name_key = case when p ->> 'name' is not null then private.recipe_fold(p ->> 'name') end,
        servings = (p ->> 'servings')::integer,
        servings_label = p ->> 'servingsLabel',
        prep_minutes = (p ->> 'prepMinutes')::integer,
        cook_minutes = (p ->> 'cookMinutes')::integer,
        notes = p ->> 'notes',
        tags = coalesce((select array_agg(t.value #>> '{}' order by t.ordinality)
          from pg_catalog.jsonb_array_elements(p -> 'tags') with ordinality t), '{}'),
        tag_keys = coalesce((select array_agg(private.recipe_fold(t.value #>> '{}') order by t.ordinality)
          from pg_catalog.jsonb_array_elements(p -> 'tags') with ordinality t), '{}'),
        updated_by = p_user_id,
        updated_at = pg_catalog.now()
      where r.id = p_recipe_id;
    delete from private.recipe_ingredients i where i.recipe_id = p_recipe_id;
    insert into private.recipe_ingredients (
      recipe_id, position, name, name_key, quantity_num, quantity_den, quantity_style, unit, note
    )
      select p_recipe_id, (e.ordinality - 1)::integer, e.value ->> 'name',
        private.recipe_fold(e.value ->> 'name'),
        (e.value #>> '{quantity,num}')::bigint, (e.value #>> '{quantity,den}')::integer,
        e.value #>> '{quantity,style}', e.value ->> 'unit', e.value ->> 'note'
      from pg_catalog.jsonb_array_elements(p -> 'ingredients') with ordinality e;
    delete from private.recipe_steps s where s.recipe_id = p_recipe_id;
    insert into private.recipe_steps (recipe_id, position, body)
      select p_recipe_id, (e.ordinality - 1)::integer, e.value #>> '{}'
      from pg_catalog.jsonb_array_elements(p -> 'steps') with ordinality e;
  end
  $$;

-- Covers -------------------------------------------------------------------------------------------

-- The pool a recipe's cover is charged to: its Home's for a Home recipe, otherwise its owner's (a
-- draft's is always its creator's).
create function private.recipe_pool(p_recipe private.recipes) returns private.storage_pools
  language sql volatile security definer set search_path = '' as $$
  select * from private.lock_storage_pool(
    case when p_recipe.owner_home_id is null then p_recipe.owner_user_id end, p_recipe.owner_home_id);
  $$;

-- Moves a ready file into another pool, under both pools' locks (in id order), if it fits there.
-- False (nothing changes) when the target pool has no room. Used when a cover follows its recipe
-- from the creator's Personal space into a Home on publication.
create function private.move_file_to_pool(p_file_id uuid, p_pool_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found or v_file.pool_id = p_pool_id then
      return found;
    end if;
    perform 1 from private.storage_pools p where p.id in (v_file.pool_id, p_pool_id)
      order by p.id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    select * into v_pool from private.storage_pools p where p.id = p_pool_id;
    if v_file.status <> 'ready' then
      return false;
    end if;
    select * into v_usage from private.storage_usage(p_pool_id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + v_file.size_bytes
       > private.storage_allowance(v_pool) then
      return false;
    end if;
    update private.stored_files f set pool_id = p_pool_id where f.id = v_file.id;
    perform private.storage_reassess(v_file.pool_id);
    perform private.storage_reassess(p_pool_id);
    return true;
  end
  $$;

-- Sets a recipe's cover to p_file_id (null: none) as part of a save by p_user_id. The current cover
-- stays as it is. A new one must be the caller's own ready cover upload, opened for this recipe or
-- for a recipe not created yet; it moves into the recipe's pool when it is elsewhere. A replaced or
-- removed cover is retired (counted and recoverable for 7 days, then purged; never shown again:
-- latest-only). Outcomes: null (done), 'invalid_cover', 'storage_full'.
create function private.adopt_recipe_cover(p_recipe private.recipes, p_file_id uuid, p_user_id uuid)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
  begin
    if p_file_id is not distinct from p_recipe.cover_file_id then
      return null;
    end if;
    if p_file_id is not null then
      if not exists (
        select 1 from private.recipe_cover_uploads u
        join private.stored_files f on f.id = u.file_id
        where u.file_id = p_file_id and u.user_id = p_user_id
          and (u.recipe_id is null or u.recipe_id = p_recipe.id)
          and f.status = 'ready' and f.purpose = 'recipe_cover'
      ) then
        return 'invalid_cover';
      end if;
      v_pool := private.recipe_pool(p_recipe);
      if not private.move_file_to_pool(p_file_id, v_pool.id) then
        return 'storage_full';
      end if;
      delete from private.recipe_cover_uploads u where u.file_id = p_file_id;
    end if;
    update private.recipes r set cover_file_id = p_file_id where r.id = p_recipe.id;
    if p_recipe.cover_file_id is not null then
      perform private.retire_file(p_recipe.cover_file_id);
    end if;
    return null;
  end
  $$;

-- Whether content p meets the published minimum: a name and at least one ingredient or step.
create function private.content_is_complete(p jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  select p ->> 'name' is not null
    and (pg_catalog.jsonb_array_length(p -> 'ingredients') > 0
      or pg_catalog.jsonb_array_length(p -> 'steps') > 0);
  $$;

-- Serializes the per-context limit check, so two creates or publishes cannot both take the last place.
create function private.lock_recipe_context(p_home_id uuid, p_user_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('recipes:' || coalesce(p_home_id, p_user_id)::text, 0));
  $$;

-- Whether the context (a Home, or the person's Personal space with their drafts) is full.
create function private.recipe_context_full(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.recipes r
    where ((p_home_id is null and r.owner_user_id = p_user_id) or r.owner_home_id = p_home_id)
      and r.deleted_at is null) >= private.recipe_limit('recipes');
  $$;

-- The caller's context ------------------------------------------------------------------------------

-- What the caller may do in a context. 42501 for a Home they are not in.
create function public.get_recipe_context(p_home_id uuid default null)
returns table (can_create boolean, can_manage boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    return query select true,
      private.can_manage_recipes(case when p_home_id is null then v_user_id end, p_home_id, v_user_id);
  end
  $$;

-- Creating ------------------------------------------------------------------------------------------

-- Creates a recipe: a private draft (p_publish false; p_home_id is only its intended destination) or
-- a recipe published at once into the caller's Personal space or a Home they belong to. Any current
-- member may publish into their Home. A retry with the same id answers 'exists'. Outcomes:
-- 'created' (with revision and status), 'exists', 'id_taken', 'incomplete' (publishing without the
-- minimum), 'limit_reached', 'invalid_cover', 'storage_full'. 22023 for invalid content; 42501 for a
-- Home the caller is not in.
create function public.create_recipe(
  p_id uuid, p_content jsonb, p_home_id uuid default null, p_publish boolean default false
) returns table (outcome text, revision integer, status text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.recipes;
    v_recipe private.recipes;
    v_publish boolean := coalesce(p_publish, false);
    v_refusal text;
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if p_id is null or not private.valid_recipe_content(p_content) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.recipes r where r.id = p_id;
    if found then
      if v_existing.created_by = v_user_id and private.can_see_recipe(v_existing, v_user_id) then
        return query select 'exists', v_existing.revision, v_existing.status;
      else
        return query select 'id_taken', null::integer, null::text;
      end if;
      return;
    end if;
    if v_publish and not private.content_is_complete(p_content) then
      return query select 'incomplete', null::integer, null::text;
      return;
    end if;
    -- Membership first (a departure waits), then the context.
    if not private.hold_membership(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    perform private.lock_recipe_context(case when v_publish then p_home_id end, v_user_id);
    if private.recipe_context_full(case when v_publish then p_home_id end, v_user_id) then
      return query select 'limit_reached', null::integer, null::text;
      return;
    end if;
    begin
      insert into private.recipes (
        id, owner_user_id, owner_home_id, status, draft_home_id, name, created_by, updated_by,
        published_at
      ) values (
        p_id,
        case when v_publish and p_home_id is not null then null else v_user_id end,
        case when v_publish then p_home_id end,
        case when v_publish then 'published' else 'draft' end,
        case when v_publish then null else p_home_id end,
        p_content ->> 'name', v_user_id, v_user_id,
        case when v_publish then pg_catalog.now() end
      )
      on conflict (id) do nothing
      returning * into v_recipe;
      if v_recipe.id is null then
        -- The same id arrived twice at once: the other request created it (or someone else holds it).
        return query select case when r.created_by = v_user_id then 'exists' else 'id_taken' end,
          case when r.created_by = v_user_id then r.revision end,
          case when r.created_by = v_user_id then r.status end
          from private.recipes r where r.id = p_id;
        return;
      end if;
      perform private.write_recipe_content(v_recipe.id, p_content, v_user_id);
      v_refusal := private.adopt_recipe_cover(v_recipe, (p_content ->> 'coverFileId')::uuid, v_user_id);
      if v_refusal is not null then
        raise exception using errcode = 'MDR01', message = v_refusal;
      end if;
    exception when sqlstate 'MDR01' then
      -- Nothing of this create is kept.
      return query select sqlerrm, null::integer, null::text;
      return;
    end;
    if v_publish then
      perform private.audit_recipe('recipe.published', p_home_id, v_recipe.id);
    end if;
    return query select 'created', 1, v_recipe.status;
  end
  $$;

-- Saving --------------------------------------------------------------------------------------------

-- Loads a recipe for a change by p_user_id, locked: null when it is missing, deleted or not theirs to
-- see. The caller holds the membership of its Home first (lock order).
create function private.lock_recipe(p_recipe_id uuid, p_user_id uuid) returns private.recipes
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_recipe private.recipes;
  begin
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not found then
      return null;
    end if;
    perform private.hold_membership(v_recipe.owner_home_id, p_user_id);
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for update;
    if not private.can_see_recipe(v_recipe, p_user_id) then
      return null;
    end if;
    return v_recipe;
  end
  $$;

-- Whether p_user_id holds the recipe's editing lock now, from the session p_token.
create function private.holds_recipe_lock(p_recipe_id uuid, p_user_id uuid, p_token uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.recipe_edit_locks l
    where l.recipe_id = p_recipe_id and l.user_id = p_user_id and l.token = p_token
      and l.expires_at > pg_catalog.now()
  );
  $$;

-- Saves a recipe's content if nobody changed it since p_expected_revision (latest-only: the old
-- content is gone). A published recipe needs the caller's unexpired editing lock from this edit
-- session (p_lock_token), the right to edit it now and the published minimum; the save releases the
-- lock. A draft needs only its creator; p_draft_home_id is its destination (null: Personal), which
-- must be a Home they belong to. Outcomes: 'saved' (new revision), 'conflict' (current revision),
-- 'lock_lost', 'incomplete', 'destination_unavailable', 'invalid_cover', 'storage_full',
-- 'not_found', 'not_permitted'. 22023 for invalid content.
create function public.update_recipe(
  p_recipe_id uuid, p_expected_revision integer, p_content jsonb, p_lock_token uuid default null,
  p_draft_home_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_refusal text;
    v_destination_ok boolean;
  begin
    if p_recipe_id is null or p_expected_revision is null or not private.valid_recipe_content(p_content) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- A draft's destination membership before the draft row (lock order).
    v_destination_ok := private.hold_membership(p_draft_home_id, v_user_id);
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_edit_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_recipe.status = 'published' then
      -- The lock row is the recipe's: locked after the recipe row (lock order).
      perform 1 from private.recipe_edit_locks l where l.recipe_id = v_recipe.id for update;
      if p_lock_token is null or not private.holds_recipe_lock(v_recipe.id, v_user_id, p_lock_token) then
        return query select 'lock_lost', v_recipe.revision;
        return;
      end if;
    elsif not v_destination_ok then
      return query select 'destination_unavailable', v_recipe.revision;
      return;
    end if;
    if v_recipe.revision <> p_expected_revision then
      return query select 'conflict', v_recipe.revision;
      return;
    end if;
    if v_recipe.status = 'published' and not private.content_is_complete(p_content) then
      return query select 'incomplete', v_recipe.revision;
      return;
    end if;
    begin
      perform private.write_recipe_content(v_recipe.id, p_content, v_user_id);
      v_refusal := private.adopt_recipe_cover(v_recipe, (p_content ->> 'coverFileId')::uuid, v_user_id);
      if v_refusal is not null then
        raise exception using errcode = 'MDR01', message = v_refusal;
      end if;
    exception when sqlstate 'MDR01' then
      return query select sqlerrm, v_recipe.revision;
      return;
    end;
    update private.recipes r
      set revision = r.revision + 1,
        draft_home_id = case when r.status = 'draft' then p_draft_home_id end,
        destination_lost = false
      where r.id = v_recipe.id
      returning * into v_recipe;
    if v_recipe.status = 'published' then
      delete from private.recipe_edit_locks l where l.recipe_id = v_recipe.id;
      perform private.audit_recipe('recipe.updated', v_recipe.owner_home_id, v_recipe.id);
    end if;
    return query select 'saved', v_recipe.revision;
  end
  $$;

-- Publishing ----------------------------------------------------------------------------------------

-- Publishes the caller's draft into their Personal space (p_home_id null) or a Home they belong to,
-- after they reviewed the destination and its audience. Rechecks membership and the minimum now.
-- Publishing into a Home moves the draft's cover into that Home's storage pool, if it fits. Never
-- creates anything in any other Home. A repeated or doubled publish answers 'already_published'
-- (p_request_id is kept with the recipe for tracing). Outcomes: 'published' (with the new
-- revision), 'already_published', 'conflict', 'incomplete', 'limit_reached', 'storage_full',
-- 'not_found'. 42501 for a Home the caller is not in.
create function public.publish_recipe(
  p_recipe_id uuid, p_expected_revision integer, p_request_id uuid, p_home_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_pool private.storage_pools;
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if p_recipe_id is null or p_expected_revision is null or p_request_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- Membership of the destination first (lock order), then the draft.
    if not private.hold_membership(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for update;
    -- Published already, by this request or an earlier one of the same creator: nothing to do.
    if v_recipe.id is not null and v_recipe.status = 'published' and v_recipe.created_by = v_user_id
       and private.can_see_recipe(v_recipe, v_user_id) then
      return query select 'already_published', v_recipe.revision;
      return;
    end if;
    if v_recipe.id is null or v_recipe.status <> 'draft' or not private.can_see_recipe(v_recipe, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_recipe.revision <> p_expected_revision then
      return query select 'conflict', v_recipe.revision;
      return;
    end if;
    if not private.recipe_is_complete(v_recipe.id) then
      return query select 'incomplete', v_recipe.revision;
      return;
    end if;
    perform private.lock_recipe_context(p_home_id, v_user_id);
    if p_home_id is not null and private.recipe_context_full(p_home_id, v_user_id) then
      return query select 'limit_reached', v_recipe.revision;
      return;
    end if;
    if p_home_id is not null and v_recipe.cover_file_id is not null then
      v_pool := private.lock_storage_pool(null, p_home_id);
      if not private.move_file_to_pool(v_recipe.cover_file_id, v_pool.id) then
        return query select 'storage_full', v_recipe.revision;
        return;
      end if;
    end if;
    update private.recipes r
      set status = 'published',
        owner_user_id = case when p_home_id is null then v_user_id end,
        owner_home_id = p_home_id,
        draft_home_id = null, destination_lost = false,
        publish_request_id = p_request_id,
        published_at = pg_catalog.now(), updated_at = pg_catalog.now(), updated_by = v_user_id,
        revision = r.revision + 1
      where r.id = v_recipe.id
      returning * into v_recipe;
    -- Cover uploads still open for the draft were charged to the Personal space; they can no longer
    -- be adopted there and the expiry job retires them.
    delete from private.recipe_cover_uploads u where u.recipe_id = v_recipe.id;
    perform private.audit_recipe('recipe.published', p_home_id, v_recipe.id);
    return query select 'published', v_recipe.revision;
  end
  $$;

-- Editing locks -------------------------------------------------------------------------------------

-- Takes the exclusive editing lock of a published recipe for the edit session p_token, when the
-- caller may edit it now. Atomic: the recipe row is locked first, so of two simultaneous attempts
-- exactly one wins and the other sees the winner's lock. The caller's own lock from another session
-- (another tab or device) is replaced only with p_take_over. The lock lasts lock_seconds after the
-- last heartbeat. Outcomes: 'acquired' (with the recipe's revision and the expiry), 'locked' (who
-- holds it: the caller themselves, or a member of the recipe's Home by membership id), 'draft' (a
-- draft needs no lock), 'not_found', 'not_permitted'.
create function public.acquire_recipe_lock(
  p_recipe_id uuid, p_token uuid, p_take_over boolean default false
) returns table (
  outcome text, revision integer, expires_at timestamptz, held_by_me boolean, held_by_member uuid
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_lock private.recipe_edit_locks;
  begin
    if p_recipe_id is null or p_token is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return query select 'not_found', null::integer, null::timestamptz, false, null::uuid;
      return;
    end if;
    if v_recipe.status = 'draft' then
      return query select 'draft', v_recipe.revision, null::timestamptz, false, null::uuid;
      return;
    end if;
    if not private.can_edit_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::integer, null::timestamptz, false, null::uuid;
      return;
    end if;
    select * into v_lock from private.recipe_edit_locks l where l.recipe_id = v_recipe.id for update;
    if v_lock.recipe_id is not null and v_lock.expires_at > pg_catalog.now()
       and not (v_lock.user_id = v_user_id and (v_lock.token = p_token or coalesce(p_take_over, false))) then
      return query select 'locked', v_recipe.revision, v_lock.expires_at, v_lock.user_id = v_user_id,
        private.member_ref(v_recipe.owner_home_id, v_lock.user_id);
      return;
    end if;
    insert into private.recipe_edit_locks as l (recipe_id, user_id, token, acquired_at, expires_at)
      values (v_recipe.id, v_user_id, p_token, pg_catalog.now(),
        pg_catalog.now() + pg_catalog.make_interval(secs => private.recipe_limit('lock_seconds')))
      on conflict on constraint recipe_edit_locks_pkey do update
        set user_id = excluded.user_id, token = excluded.token,
          acquired_at = case when l.token = excluded.token then l.acquired_at else excluded.acquired_at end,
          expires_at = excluded.expires_at
      returning * into v_lock;
    return query select 'acquired', v_recipe.revision, v_lock.expires_at, true, null::uuid;
  end
  $$;

-- Keeps the caller's lock from session p_token alive (a heartbeat). An expired lock is never revived
-- here: the editor acquires again, which fails when someone else took it meanwhile. A caller who may
-- no longer edit loses it. Outcomes: 'renewed' (with the new expiry), 'lock_lost'.
create function public.renew_recipe_lock(p_recipe_id uuid, p_token uuid)
returns table (outcome text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_expires timestamptz;
  begin
    if p_recipe_id is null or p_token is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_edit_recipe(v_recipe, v_user_id) then
      delete from private.recipe_edit_locks l where l.recipe_id = p_recipe_id and l.user_id = v_user_id;
      return query select 'lock_lost', null::timestamptz;
      return;
    end if;
    update private.recipe_edit_locks l
      set expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => private.recipe_limit('lock_seconds'))
      where l.recipe_id = p_recipe_id and l.user_id = v_user_id and l.token = p_token
        and l.expires_at > pg_catalog.now()
      returning l.expires_at into v_expires;
    if v_expires is null then
      return query select 'lock_lost', null::timestamptz;
      return;
    end if;
    return query select 'renewed', v_expires;
  end
  $$;

-- Gives up the caller's lock from session p_token (Cancel, leaving the editor). True when it held it.
create function public.release_recipe_lock(p_recipe_id uuid, p_token uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_recipe_id is null or p_token is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    delete from private.recipe_edit_locks l
      where l.recipe_id = p_recipe_id and l.user_id = v_user_id and l.token = p_token;
    return found;
  end
  $$;

-- Deleting ------------------------------------------------------------------------------------------

-- Moves a recipe to the trash for 7 days with its cover (a draft: discards it into its creator's
-- Personal trash). Its creator while a member, or a recipe manager; a draft only its creator. A
-- recipe someone else is editing now answers 'locked' (nobody force-unlocks another person's edit).
-- Outcomes: 'deleted' (with the entry), 'locked', 'not_found', 'not_permitted'.
create function public.delete_recipe(p_recipe_id uuid)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.can_edit_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    if exists (
      select 1 from private.recipe_edit_locks l
      where l.recipe_id = v_recipe.id and l.user_id <> v_user_id and l.expires_at > pg_catalog.now()
    ) then
      return query select 'locked', null::uuid;
      return;
    end if;
    delete from private.recipe_edit_locks l where l.recipe_id = v_recipe.id;
    delete from private.recipe_cover_uploads u where u.recipe_id = v_recipe.id;
    update private.recipes r set deleted_at = pg_catalog.now() where r.id = v_recipe.id;
    perform private.audit_recipe('recipe.deleted', v_recipe.owner_home_id, v_recipe.id);
    return query select 'deleted',
      private.trash_move(v_user_id, 'recipes', 'recipe', v_recipe.id, v_recipe.owner_user_id,
        v_recipe.owner_home_id, v_recipe.name,
        case when v_recipe.cover_file_id is not null then array[v_recipe.cover_file_id] else '{}'::uuid[] end);
  end
  $$;

-- Reading --------------------------------------------------------------------------------------------

-- A LIKE pattern matching p (already folded) anywhere, with its wildcards taken literally.
create function private.recipe_like(p_folded text) returns text
  language sql immutable strict set search_path = '' as $$
  select '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_folded, '\', '\\'),
    '%', '\%'), '_', '\_') || '%';
  $$;

-- One page of a context's published recipes (the Personal space, or a Home the caller belongs to),
-- searched, filtered and sorted, with the filtered total. Drafts never appear (they are nobody's
-- context but their creator's, and listed only by list_my_recipe_drafts).
--   p_query: matches the name or any ingredient name, partially, ignoring case and accents; a row
--     found only through an ingredient names the first matching one (matched_ingredient).
--   p_tags: recipes carrying all of them (compared like the query). p_favorites: the caller's own.
--   p_sort: 'name_asc', 'name_desc', 'added_desc', 'added_asc', 'updated_desc', 'updated_asc'; ties
--     by name, then id.
-- Ratings are the context's: the average and count over current members only, and the caller's own.
create function public.list_recipes(
  p_home_id uuid default null, p_query text default null, p_tags text[] default null,
  p_favorites boolean default false, p_sort text default 'name_asc', p_limit integer default 24,
  p_offset integer default 0
) returns table (
  id uuid, name text, cover_file_id uuid, tags text[], servings integer, prep_minutes integer,
  cook_minutes integer, matched_ingredient text, favorite boolean, my_rating smallint,
  rating_average numeric, rating_count integer, published_at timestamptz, updated_at timestamptz,
  revision integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pattern text;
    v_tag_keys text[];
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if p_sort is null or p_sort not in ('name_asc', 'name_desc', 'added_desc', 'added_asc',
         'updated_desc', 'updated_asc')
       or p_limit is null or p_limit not between 1 and private.recipe_limit('page')
       or p_offset is null or p_offset not between 0 and private.recipe_limit('max_offset')
       or pg_catalog.char_length(coalesce(p_query, '')) > private.recipe_limit('query')
       or coalesce(cardinality(p_tags), 0) > private.recipe_limit('tags') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if pg_catalog.btrim(coalesce(p_query, '')) <> '' then
      v_pattern := private.recipe_like(private.recipe_fold(p_query));
    end if;
    select coalesce(array_agg(distinct private.recipe_fold(t)), '{}') into v_tag_keys
      from pg_catalog.unnest(coalesce(p_tags, '{}')) t where t is not null;
    return query
      with base as (
        select r.*,
          case when v_pattern is not null and not coalesce(r.name_key like v_pattern escape '\', false) then
            (select i.name from private.recipe_ingredients i
              where i.recipe_id = r.id and i.name_key like v_pattern escape '\'
              order by i.position limit 1)
          end as matched
        from private.recipes r
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id)
          and r.status = 'published' and r.deleted_at is null
          and r.tag_keys @> v_tag_keys
          and (not coalesce(p_favorites, false) or exists (
            select 1 from private.recipe_favorites f
            where f.user_id = v_user_id and f.recipe_id = r.id
              and f.context_home_id is not distinct from p_home_id))
          and (v_pattern is null or r.name_key like v_pattern escape '\' or exists (
            select 1 from private.recipe_ingredients i
            where i.recipe_id = r.id and i.name_key like v_pattern escape '\'))
      ), page as (
        select b.*, count(*) over ()::integer as total
        from base b
        order by
          case when p_sort = 'name_desc' then b.name_key end desc,
          case when p_sort = 'added_desc' then b.published_at end desc,
          case when p_sort = 'added_asc' then b.published_at end asc,
          case when p_sort = 'updated_desc' then b.updated_at end desc,
          case when p_sort = 'updated_asc' then b.updated_at end asc,
          b.name_key asc, b.id asc
        limit p_limit offset p_offset
      )
      select p.id, p.name, p.cover_file_id, p.tags, p.servings, p.prep_minutes, p.cook_minutes,
        p.matched,
        exists (select 1 from private.recipe_favorites f where f.user_id = v_user_id
          and f.recipe_id = p.id and f.context_home_id is not distinct from p_home_id),
        (select rt.stars from private.recipe_ratings rt where rt.recipe_id = p.id and rt.user_id = v_user_id),
        g.average, g.rating_count, p.published_at, p.updated_at, p.revision, p.total
      from page p
      cross join lateral private.recipe_rating(p.id, p.owner_user_id, p.owner_home_id) g
      order by
        case when p_sort = 'name_desc' then p.name_key end desc,
        case when p_sort = 'added_desc' then p.published_at end desc,
        case when p_sort = 'added_asc' then p.published_at end asc,
        case when p_sort = 'updated_desc' then p.updated_at end desc,
        case when p_sort = 'updated_asc' then p.updated_at end asc,
        p.name_key asc, p.id asc;
  end
  $$;

-- The tags used by a context's published recipes, each once (its most recent spelling), with how many
-- recipes carry it, in name order.
create function public.list_recipe_tags(p_home_id uuid default null)
returns table (tag text, recipe_count integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    return query
      select (array_agg(t.tag order by t.updated_at desc, t.tag))[1], count(distinct t.recipe_id)::integer
      from (
        select r.id as recipe_id, r.updated_at, u.tag, private.recipe_fold(u.tag) as tag_key
        from private.recipes r
        cross join lateral pg_catalog.unnest(r.tags) as u(tag)
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id)
          and r.status = 'published' and r.deleted_at is null
      ) t
      group by t.tag_key
      order by t.tag_key
      limit 500;
  end
  $$;

-- The caller's drafts, most recently edited first, with each one's intended destination (a Home's
-- name only while they still belong to it) and whether it was lost.
create function public.list_my_recipe_drafts()
returns table (
  id uuid, name text, destination_home_id uuid, destination_home_name text,
  destination_lost boolean, cover_file_id uuid, updated_at timestamptz, revision integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select r.id, r.name, r.draft_home_id, h.name, r.destination_lost, r.cover_file_id, r.updated_at,
        r.revision
      from private.recipes r
      left join public.homes h on h.id = r.draft_home_id and private.is_home_member(h.id, v_user_id)
      where r.owner_user_id = v_user_id and r.status = 'draft' and r.deleted_at is null
      order by r.updated_at desc, r.id
      limit private.recipe_limit('recipes');
  end
  $$;

-- One recipe or draft with everything its pages show, or null when it is missing, deleted or not the
-- caller's to see. People are membership ids (null: departed, or the Personal space) and "is me". The
-- editing lock says only whether someone holds it and, in a Home, which member.
create function public.get_recipe(p_recipe_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_lock private.recipe_edit_locks;
    v_rating record;
    v_home uuid;
    v_can_edit boolean;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_see_recipe(v_recipe, v_user_id) then
      return null;
    end if;
    v_home := v_recipe.owner_home_id;
    v_can_edit := private.can_edit_recipe(v_recipe, v_user_id);
    select * into v_lock from private.recipe_edit_locks l
      where l.recipe_id = v_recipe.id and l.expires_at > pg_catalog.now();
    select * into v_rating from private.recipe_rating(v_recipe.id, v_recipe.owner_user_id, v_home);
    return pg_catalog.jsonb_build_object(
      'id', v_recipe.id,
      'status', v_recipe.status,
      'homeId', v_home,
      'draftHomeId', case when v_recipe.status = 'draft'
        and private.is_home_member(v_recipe.draft_home_id, v_user_id) then v_recipe.draft_home_id end,
      'destinationLost', v_recipe.destination_lost,
      'name', v_recipe.name,
      'servings', v_recipe.servings,
      'servingsLabel', v_recipe.servings_label,
      'prepMinutes', v_recipe.prep_minutes,
      'cookMinutes', v_recipe.cook_minutes,
      'notes', v_recipe.notes,
      'tags', pg_catalog.to_jsonb(v_recipe.tags),
      'coverFileId', v_recipe.cover_file_id,
      'ingredients', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name', i.name,
          'quantity', case when i.quantity_num is not null then pg_catalog.jsonb_build_object(
            'num', i.quantity_num, 'den', i.quantity_den, 'style', i.quantity_style) end,
          'unit', i.unit, 'note', i.note) order by i.position)
        from private.recipe_ingredients i where i.recipe_id = v_recipe.id), '[]'::jsonb),
      'steps', coalesce((select pg_catalog.jsonb_agg(s.body order by s.position)
        from private.recipe_steps s where s.recipe_id = v_recipe.id), '[]'::jsonb),
      'revision', v_recipe.revision,
      'createdAt', v_recipe.created_at,
      'createdBy', pg_catalog.jsonb_build_object('me', coalesce(v_recipe.created_by = v_user_id, false),
        'member', private.member_ref(v_home, v_recipe.created_by)),
      'updatedAt', v_recipe.updated_at,
      'updatedBy', pg_catalog.jsonb_build_object('me', coalesce(v_recipe.updated_by = v_user_id, false),
        'member', private.member_ref(v_home, v_recipe.updated_by)),
      'publishedAt', v_recipe.published_at,
      'favorite', v_recipe.status = 'published' and exists (
        select 1 from private.recipe_favorites f where f.user_id = v_user_id and f.recipe_id = v_recipe.id
          and f.context_home_id is not distinct from v_home),
      'rating', pg_catalog.jsonb_build_object(
        'mine', (select rt.stars from private.recipe_ratings rt
          where rt.recipe_id = v_recipe.id and rt.user_id = v_user_id and v_recipe.status = 'published'),
        'average', case when v_recipe.status = 'published' then v_rating.average end,
        'count', case when v_recipe.status = 'published' then v_rating.rating_count else 0 end),
      'lock', case when v_lock.recipe_id is not null then pg_catalog.jsonb_build_object(
        'mine', v_lock.user_id = v_user_id,
        'member', private.member_ref(v_home, v_lock.user_id),
        'expiresAt', v_lock.expires_at) end,
      'can', pg_catalog.jsonb_build_object(
        'edit', v_can_edit,
        'delete', v_can_edit,
        'rate', v_recipe.status = 'published',
        'favorite', v_recipe.status = 'published',
        'publish', v_recipe.status = 'draft')
    );
  end
  $$;

-- Ratings and favorites -------------------------------------------------------------------------------

-- Sets (1-5) or clears (null) the caller's rating of a published recipe they may see now. A repeat
-- changes nothing. Outcomes: 'saved', 'cleared', 'not_found'; with the caller's rating and the
-- context's average and count after the change.
create function public.set_recipe_rating(p_recipe_id uuid, p_stars integer default null)
returns table (outcome text, mine integer, average numeric, rating_count integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_rating record;
  begin
    if p_recipe_id is null or (p_stars is not null and p_stars not between 1 and 5) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for share;
    if not private.can_see_recipe(v_recipe, v_user_id) or v_recipe.status <> 'published' then
      return query select 'not_found', null::integer, null::numeric, null::integer;
      return;
    end if;
    if p_stars is null then
      delete from private.recipe_ratings rt where rt.recipe_id = v_recipe.id and rt.user_id = v_user_id;
    else
      insert into private.recipe_ratings (recipe_id, user_id, stars, updated_at)
        values (v_recipe.id, v_user_id, p_stars, pg_catalog.now())
        on conflict (recipe_id, user_id) do update set stars = excluded.stars, updated_at = excluded.updated_at;
    end if;
    select * into v_rating from private.recipe_rating(v_recipe.id, v_recipe.owner_user_id, v_recipe.owner_home_id);
    return query select case when p_stars is null then 'cleared' else 'saved' end, p_stars,
      v_rating.average, v_rating.rating_count;
  end
  $$;

-- Marks (true) or unmarks (false) a published recipe the caller may see as one of their favorites in
-- its context. Set-to-state, so a repeat or a double click changes nothing. Outcomes: 'saved',
-- 'not_found'.
create function public.set_recipe_favorite(p_recipe_id uuid, p_favorite boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null or p_favorite is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for share;
    if not private.can_see_recipe(v_recipe, v_user_id) or v_recipe.status <> 'published' then
      return 'not_found';
    end if;
    if p_favorite then
      insert into private.recipe_favorites (user_id, recipe_id, context_home_id)
        values (v_user_id, v_recipe.id, v_recipe.owner_home_id)
        on conflict do nothing;
    else
      delete from private.recipe_favorites f
        where f.user_id = v_user_id and f.recipe_id = v_recipe.id
          and f.context_home_id is not distinct from v_recipe.owner_home_id;
    end if;
    return 'saved';
  end
  $$;

-- Widgets ----------------------------------------------------------------------------------------------

-- Recipes for a dashboard widget of one context (spec "Confirmed configurable recipe dashboard
-- widgets"): 'favorites' (the caller's own, most recently marked first), 'recent' (date added, newest
-- first), 'top_rated' (rated recipes only, by the context's average, then count, name, id) or 'random'
-- (a stable shuffle by p_seed: the same seed gives the same pick, a new seed another). Published,
-- non-deleted recipes of that context only. available is how many recipes the mode could show.
create function public.recipe_widget(
  p_home_id uuid default null, p_mode text default null, p_limit integer default null,
  p_seed text default null
) returns table (
  id uuid, name text, cover_file_id uuid, rating_average numeric, rating_count integer, available integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if p_mode is null or p_mode not in ('favorites', 'recent', 'top_rated', 'random')
       or p_limit is null or p_limit not between 1 and private.recipe_limit('widget')
       or pg_catalog.char_length(coalesce(p_seed, '')) > 64 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query
      with base as (
        select r.id, r.name, r.name_key, r.cover_file_id, r.published_at, g.average, g.rating_count,
          (select f.created_at from private.recipe_favorites f where f.user_id = v_user_id
            and f.recipe_id = r.id and f.context_home_id is not distinct from p_home_id) as favorited_at
        from private.recipes r
        cross join lateral private.recipe_rating(r.id, r.owner_user_id, r.owner_home_id) g
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id)
          and r.status = 'published' and r.deleted_at is null
      ), candidates as (
        select b.* from base b
        where case p_mode
          when 'favorites' then b.favorited_at is not null
          when 'top_rated' then b.rating_count > 0
          else true
        end
      )
      select c.id, c.name, c.cover_file_id, c.average, c.rating_count,
        (count(*) over ())::integer
      from candidates c
      order by
        case when p_mode = 'favorites' then c.favorited_at end desc,
        case when p_mode = 'recent' then c.published_at end desc,
        case when p_mode = 'top_rated' then c.average end desc,
        case when p_mode = 'top_rated' then c.rating_count end desc,
        case when p_mode = 'random' then pg_catalog.md5(c.id::text || coalesce(p_seed, '')) end,
        c.name_key, c.id
      limit p_limit;
  end
  $$;

-- Covers: storage policy and uploads -------------------------------------------------------------------

-- A recipe cover: JPEG, PNG or WebP up to 10 MB, stored as a WebP the server made (brief S24).
create or replace function private.upload_max_bytes(p_purpose text) returns bigint
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then 5242880::bigint
    when 'task_attachment' then 10485760::bigint  -- 10 MB (brief S19c)
    when 'recipe_cover' then 10485760::bigint     -- 10 MB (brief S24)
  end;
  $$;

create or replace function private.upload_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    else false
  end;
  $$;

create or replace function private.stored_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type = 'image/webp'
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type = 'image/webp'
    else false
  end;
  $$;

-- Opens an upload of a cover photo, for a recipe that does not exist yet (p_recipe_id null: charged
-- to the caller's Personal space, adopted by the create or publish that uses it) or for one they may
-- edit now: a draft of theirs, or a published recipe whose editing lock they hold from session
-- p_lock_token (charged to the recipe's pool). The same rate limits, pending limit and capacity check
-- under the pool lock as every other upload. Outcomes: 'ok' (with the file id, upload key and expiry),
-- 'not_found', 'not_permitted', 'lock_lost', 'storage_full', 'rate_limited', 'conflict' (the request
-- id was used for a different upload). Invalid type or size: 22023.
create function public.create_recipe_cover_intent(
  p_content_type text, p_size bigint, p_request_id uuid, p_recipe_id uuid default null,
  p_lock_token uuid default null
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('recipe_cover')
       or not private.upload_type_allowed('recipe_cover', p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    if p_recipe_id is not null then
      -- Recipe first, then the pool: the same order as saving and deleting.
      v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
      if v_recipe.id is null then
        return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if not private.can_edit_recipe(v_recipe, v_user_id) then
        return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if v_recipe.status = 'published'
         and (p_lock_token is null or not private.holds_recipe_lock(v_recipe.id, v_user_id, p_lock_token)) then
        return query select 'lock_lost'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      v_pool := private.recipe_pool(v_recipe);
    else
      v_pool := private.lock_storage_pool(v_user_id, null);
    end if;

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'recipe_cover' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() and exists (
           select 1 from private.recipe_cover_uploads u
           where u.file_id = v_existing.id and u.recipe_id is not distinct from v_recipe.id) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour')
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now())
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

    v_prefix := case when v_pool.owner_home_id is not null then 'h' else 'u' end;
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'recipe_cover', v_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    insert into private.recipe_cover_uploads (file_id, user_id, recipe_id)
      values (v_file.id, v_user_id, v_recipe.id);

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'recipe_cover', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- The object behind a file the caller may see now, or no row (the same answer for every reason).
-- S15 avatars and S19c task attachments as before. Recipe covers (S24): the current cover of a recipe
-- the caller may see now (a draft's only by its creator), or the caller's own cover upload that no
-- save has adopted yet (the editor's preview).
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
        );
  end
  $$;

-- storage-upload-expire (S15) also retires a finished cover upload that no save adopted, so it never
-- counts forever without being visible anywhere, and forgets the upload of one that failed or expired.
create or replace function public.expire_upload(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return 'missing';
    end if;
    -- Pool first, then the file: the same lock order as every other writer.
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'pending' and v_file.expires_at <= pg_catalog.now() then
      update private.stored_files f set status = 'failed' where f.id = v_file.id
        returning * into v_file;
    end if;
    if v_file.status = 'failed' then
      perform private.queue_object_deletion(v_file.upload_key, 'expired');
      perform private.queue_object_deletion(v_file.object_key, 'expired');
      delete from private.task_attachment_uploads u where u.file_id = v_file.id;
      delete from private.recipe_cover_uploads u where u.file_id = v_file.id;
    elsif v_file.status <> 'pending' then
      perform private.queue_object_deletion(v_file.upload_key, 'processed');
    end if;
    -- A finished avatar that was never chosen (the browser stopped after finalize) would count
    -- forever without being visible anywhere: it is retired like a replaced one (M2).
    if v_file.status = 'ready' and v_file.purpose = 'avatar' then
      perform private.retire_avatar_if_unused(v_file.created_by, v_file.id);
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    -- The same for a task attachment that was finalized but never attached.
    if v_file.status = 'ready' and v_file.purpose = 'task_attachment'
       and exists (select 1 from private.task_attachment_uploads u where u.file_id = v_file.id) then
      perform private.retire_unattached_upload(v_file.id);
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    -- And for a recipe cover no save adopted (the person cancelled, or the save never came).
    if v_file.status = 'ready' and v_file.purpose = 'recipe_cover'
       and exists (select 1 from private.recipe_cover_uploads u where u.file_id = v_file.id) then
      delete from private.recipe_cover_uploads u where u.file_id = v_file.id;
      if not exists (select 1 from private.recipes r where r.cover_file_id = v_file.id) then
        perform private.retire_file(v_file.id);
      end if;
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    return v_file.status;
  end
  $$;

-- Trash ------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before recipes keep handling every other module; these handle
-- the recipes module and hand the rest on (the chores pattern).
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_recipes;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_recipes;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_recipes;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_recipes;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_recipes;

-- A recipe's only conflict: its context is full ('recipe_limit'; delete or restore others first).
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_recipe private.recipes;
  begin
    if p_entry.module <> 'recipes' then
      return private.trash_conflict_before_recipes(p_entry);
    end if;
    select * into v_recipe from private.recipes r where r.id = p_entry.subject_id;
    if not found or v_recipe.deleted_at is null then
      return 'item_missing';
    end if;
    if private.recipe_context_full(v_recipe.owner_home_id, v_recipe.owner_user_id) then
      return 'recipe_limit';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_kind
    when 'recipe_limit' then array[]::text[]
    else private.trash_conflict_options_before_recipes(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'recipes' then
      perform private.trash_resolve_before_recipes(p_entry, p_resolution);
    end if;
    -- Recipes have no resolvable conflict.
  end
  $$;

-- The whole recipe comes back as it was deleted (never older content). Its cover comes back with it
-- while the file is still recoverable; one already purged is dropped and reported.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_recipe private.recipes;
    v_file_id uuid;
    v_lost integer := 0;
  begin
    if p_entry.module <> 'recipes' then
      return private.trash_item_restore_before_recipes(p_entry);
    end if;
    select * into v_recipe from private.recipes r where r.id = p_entry.subject_id for update;
    if v_recipe.id is null or v_recipe.deleted_at is null then
      raise exception 'recipe unavailable' using errcode = '23505';
    end if;
    perform private.lock_recipe_context(v_recipe.owner_home_id, v_recipe.owner_user_id);
    if private.recipe_context_full(v_recipe.owner_home_id, v_recipe.owner_user_id) then
      raise exception 'recipe limit' using errcode = '23505';
    end if;
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
    loop
      if not private.restore_file(v_file_id) then
        v_lost := v_lost + 1;
        update private.recipes r set cover_file_id = null where r.id = v_recipe.id and r.cover_file_id = v_file_id;
      end if;
    end loop;
    update private.recipes r set deleted_at = null where r.id = v_recipe.id;
    return v_lost;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
  begin
    if p_entry.module <> 'recipes' then
      perform private.trash_item_purge_before_recipes(p_entry);
      return;
    end if;
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
    loop
      perform private.purge_file_now(v_file_id);
    end loop;
    -- Ingredients, steps, ratings, favorites and any lock go with it (on delete cascade).
    delete from private.recipes r where r.id = p_entry.subject_id and r.deleted_at is not null;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The recipe API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_recipe_context', 'create_recipe', 'update_recipe', 'publish_recipe', 'acquire_recipe_lock',
      'renew_recipe_lock', 'release_recipe_lock', 'delete_recipe', 'list_recipes', 'list_recipe_tags',
      'list_my_recipe_drafts', 'get_recipe', 'set_recipe_rating', 'set_recipe_favorite',
      'recipe_widget', 'create_recipe_cover_intent', 'authorize_file_read'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%recipe%'
      or p.proname in ('content_is_complete', 'hold_membership', 'move_file_to_pool',
        'is_delegable_capability', 'upload_max_bytes', 'upload_type_allowed', 'stored_type_allowed',
        'trash_conflict', 'trash_conflict_options', 'trash_resolve', 'trash_item_restore',
        'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
