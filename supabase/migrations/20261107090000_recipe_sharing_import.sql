-- S25: recipe sharing, impact-reviewed deletion and URL import (brief plans/steps/S25-brief.md; ADR
-- 0032; spec "Confirmed explicitly synchronized cross-context recipe sharing", "Confirmed
-- impact-reviewed deletion of shared recipes", "Confirmed recipe URL import with editable preview",
-- "Confirmed context-owned canonical recipes and membership departure", "Confirmed optional personal
-- recipe ratings").
--
-- Sharing never copies a recipe: a share row makes the one canonical recipe visible in another Home
-- (its destination), for that Home's current members. Edits change it everywhere. Only the origin's
-- recipe managers (the Personal space's owner; in a Home its Owner and Administrators granted
-- manageHomeRecipes) share it, and only into Homes they belong to. A share is view-only unless it lets
-- the destination's recipe managers edit too; nobody in a destination deletes or shares onward. A
-- destination's recipe managers may remove their own Home's share.
--
-- Every read now has a viewing context: the Personal space or one Home. `null` as a context means
-- "where it lives" (its owner), so S24 callers keep their meaning. Ratings and favorites are counted
-- in the viewing context, and in a destination nothing names the origin or its members.
--
-- Deleting a shared recipe needs an origin recipe manager and an impact review whose token the
-- delete sends back; a changed recipe or share list makes the review stale. Its shares are paused
-- while it is in the trash and stay paused after a restore until someone reinstates each one.
--
-- Lock order (S24): Home rows and memberships first (key share), then the recipe row, then its lock
-- and share rows, then storage pools.

-- Columns, tables ---------------------------------------------------------------------------------

-- Where an imported recipe came from, set once when it is created and never changed afterwards (a
-- later change on that site never updates the recipe). Shown with the recipe as attribution.
alter table private.recipes
  add column source_url text
    constraint recipes_source_url_check check (
      source_url is null or (
        pg_catalog.char_length(source_url) <= 2000 and source_url ~ '^https?://[^[:space:][:cntrl:]]+$'
      )
    ),
  add column source_name text
    constraint recipes_source_name_check check (source_name is null or private.is_visible_name(source_name, 200)),
  add constraint recipes_source_check check (source_name is null or source_url is not null);

create index recipes_source_idx on private.recipes (source_url) where source_url is not null and deleted_at is null;

-- One row per recipe and destination Home. suspended_at: the recipe was deleted; the share gives no
-- access until a recipe manager reinstates it (also after a restore from the trash).
create table private.recipe_shares (
  recipe_id uuid not null references private.recipes (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  -- Whether the destination's recipe managers may edit it too (under the one lock).
  can_edit boolean not null default false,
  shared_by uuid references auth.users (id) on delete set null,
  shared_at timestamptz not null default now(),
  suspended_at timestamptz,
  primary key (recipe_id, home_id)
);

create index recipe_shares_home_idx on private.recipe_shares (home_id) where suspended_at is null;

-- One row per URL import started, for the per-account rate limit. Holds no URL or content.
create table private.recipe_import_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index recipe_import_attempts_user_idx on private.recipe_import_attempts (user_id, created_at);

comment on table private.recipe_shares is 'S25: recipes shared with other Homes. Not exposed through the API.';
comment on table private.recipe_import_attempts is 'S25: recipe URL import rate limit. Not exposed through the API.';

alter table private.recipe_shares enable row level security;
alter table private.recipe_import_attempts enable row level security;
revoke all on private.recipe_shares, private.recipe_import_attempts
  from public, anon, authenticated, service_role;

create or replace function private.recipe_limit(p_name text) returns integer
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
    when 'source_url' then 2000
    when 'imports_per_hour' then 20    -- URL imports per account (brief S25)
    when 'duplicates' then 5
  end;
  $$;

-- Permission helpers ------------------------------------------------------------------------------

-- Whether the recipe is shared with p_home_id now (not paused).
create function private.recipe_shared_with(p_recipe_id uuid, p_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.recipe_shares s
    where s.recipe_id = p_recipe_id and s.home_id = p_home_id and s.suspended_at is null
  );
  $$;

-- Whether the recipe is shared with any Home now (not paused).
create function private.recipe_has_shares(p_recipe_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.recipe_shares s where s.recipe_id = p_recipe_id and s.suspended_at is null
  );
  $$;

-- Whether p_user_id may see the recipe now from anywhere: a draft only its creator (who owns it); a
-- published recipe its Personal space's owner, a current member of its Home, or a current member of
-- a Home it is shared with. Never a deleted one.
create or replace function private.can_see_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  -- Every term is false, never null, when it does not hold.
  select p_user_id is not null and p_recipe.id is not null and p_recipe.deleted_at is null and (
    coalesce(p_recipe.owner_user_id = p_user_id, false)
    or (p_recipe.status = 'published' and p_recipe.owner_home_id is not null
      and private.is_home_member(p_recipe.owner_home_id, p_user_id))
    or (p_recipe.status = 'published' and exists (
      select 1 from private.recipe_shares s
      where s.recipe_id = p_recipe.id and s.suspended_at is null
        and private.is_home_member(s.home_id, p_user_id)))
  );
  $$;

-- Whether p_user_id may see the recipe from one context: p_home_id null is where it lives (its
-- owner: the Personal space, its Home, or the draft's creator); a Home is that Home's own recipes
-- and those shared with it, for its current members, published only.
create function private.recipe_visible_in(p_recipe private.recipes, p_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_recipe.id is not null and p_recipe.deleted_at is null and (
    case when p_home_id is null then
      coalesce(p_recipe.owner_user_id = p_user_id, false)
      or (p_recipe.status = 'published' and p_recipe.owner_home_id is not null
        and private.is_home_member(p_recipe.owner_home_id, p_user_id))
    else
      p_recipe.status = 'published' and private.is_home_member(p_home_id, p_user_id)
      and (coalesce(p_recipe.owner_home_id = p_home_id, false)
        or private.recipe_shared_with(p_recipe.id, p_home_id))
    end
  );
  $$;

-- Edit (under the lock): a draft's creator; a recipe manager of its origin; the current member of
-- its Home who created it; or a recipe manager of a Home it is shared with for editing.
create or replace function private.can_edit_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.can_see_recipe(p_recipe, p_user_id) and (
    private.can_manage_recipes(p_recipe.owner_user_id, p_recipe.owner_home_id, p_user_id)
    or (p_recipe.owner_home_id is not null and coalesce(p_recipe.created_by = p_user_id, false)
      and private.is_home_member(p_recipe.owner_home_id, p_user_id))
    or (p_recipe.status = 'published' and exists (
      select 1 from private.recipe_shares s
      where s.recipe_id = p_recipe.id and s.suspended_at is null and s.can_edit
        and private.has_home_capability(s.home_id, p_user_id, 'manageHomeRecipes')))
  );
  $$;

-- Delete (to the trash): only from its origin. A draft's creator; a recipe manager of the origin; the
-- current member of its Home who created it, unless it is shared (deleting a shared recipe removes
-- it from every destination, so it takes a recipe manager).
create function private.can_delete_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.recipe_visible_in(p_recipe, null, p_user_id) and (
    private.can_manage_recipes(p_recipe.owner_user_id, p_recipe.owner_home_id, p_user_id)
    or (p_recipe.owner_home_id is not null and coalesce(p_recipe.created_by = p_user_id, false)
      and not exists (select 1 from private.recipe_shares s where s.recipe_id = p_recipe.id))
  );
  $$;

-- Share, change and remove its shares, and see where it is shared: a recipe manager of its origin,
-- for a published recipe.
create function private.can_share_recipe(p_recipe private.recipes, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_recipe.status = 'published' and private.recipe_visible_in(p_recipe, null, p_user_id)
    and private.can_manage_recipes(p_recipe.owner_user_id, p_recipe.owner_home_id, p_user_id);
  $$;

-- Holds every Home membership through which p_user_id may edit the recipe by a share (key share, in
-- id order), so leaving one of those Homes waits for a save under way. Part of private.lock_recipe,
-- before the recipe row.
create function private.hold_share_memberships(p_recipe_id uuid, p_user_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_home_id uuid;
  begin
    for v_home_id in
      select s.home_id from private.recipe_shares s
      where s.recipe_id = p_recipe_id and s.suspended_at is null
      order by s.home_id
    loop
      perform private.hold_membership(v_home_id, p_user_id);
    end loop;
  end
  $$;

create or replace function private.lock_recipe(p_recipe_id uuid, p_user_id uuid) returns private.recipes
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_recipe private.recipes;
  begin
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not found then
      return null;
    end if;
    perform private.hold_membership(v_recipe.owner_home_id, p_user_id);
    perform private.hold_share_memberships(v_recipe.id, p_user_id);
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for update;
    if not private.can_see_recipe(v_recipe, p_user_id) then
      return null;
    end if;
    return v_recipe;
  end
  $$;

-- The editing locks of people who may no longer edit the recipe end (after a share is removed or
-- made view-only). Their next save answers lock_lost and changes nothing.
create function private.end_recipe_locks_without_rights(p_recipe_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  delete from private.recipe_edit_locks l
    using private.recipes r
    where l.recipe_id = p_recipe_id and r.id = l.recipe_id and not private.can_edit_recipe(r, l.user_id);
  $$;

-- The ratings average of a recipe in a viewing context (spec L2652): only ratings by current members
-- of that context count (Personal: only its owner's). p_home_id null: where it lives.
create function private.recipe_context_rating(p_recipe private.recipes, p_home_id uuid)
returns table (average numeric, rating_count integer)
  language sql stable security definer set search_path = '' as $$
  select * from private.recipe_rating(p_recipe.id,
    case when p_home_id is null then p_recipe.owner_user_id end,
    coalesce(p_home_id, p_recipe.owner_home_id));
  $$;

-- Member departure ---------------------------------------------------------------------------------

-- Before a membership ends: the person's editing locks on that Home's recipes, and on recipes shared
-- into it, end at once (a later save is refused; another right to edit, if any, takes a new lock);
-- their drafts meant for that Home lose the destination, flagged. Recipes and their shares stay.
create or replace function private.recipes_member_left() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.recipe_edit_locks l
      using private.recipes r
      where l.recipe_id = r.id and l.user_id = old.user_id
        and (r.owner_home_id = old.home_id or exists (
          select 1 from private.recipe_shares s where s.recipe_id = r.id and s.home_id = old.home_id));
    update private.recipes r set draft_home_id = null, destination_lost = true
      where r.status = 'draft' and r.owner_user_id = old.user_id and r.draft_home_id = old.home_id;
    return old;
  end
  $$;

-- Creating (with the import source) ---------------------------------------------------------------

-- Whether an import source is well formed: absent or null, or { "url": http(s) URL, "name": visible
-- name or null }.
create function private.valid_recipe_source(p jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  select p is null or pg_catalog.jsonb_typeof(p) = 'null' or (
    pg_catalog.jsonb_typeof(p) = 'object'
    and pg_catalog.jsonb_typeof(p -> 'url') = 'string'
    and pg_catalog.char_length(p ->> 'url') <= private.recipe_limit('source_url')
    and (p ->> 'url') ~ '^https?://[^[:space:][:cntrl:]]+$'
    and coalesce(pg_catalog.jsonb_typeof(p -> 'name'), 'null') in ('null', 'string')
    and (pg_catalog.jsonb_typeof(p -> 'name') is distinct from 'string'
      or private.is_visible_name(p ->> 'name', 200))
  );
  $$;

-- S24's create_recipe, plus the optional content.source of an imported recipe, kept with it for good.
-- Saves never change it (update_recipe ignores content.source).
create or replace function public.create_recipe(
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
    if p_id is null or not private.valid_recipe_content(p_content)
       or not private.valid_recipe_source(p_content -> 'source') then
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
        published_at, source_url, source_name
      ) values (
        p_id,
        case when v_publish and p_home_id is not null then null else v_user_id end,
        case when v_publish then p_home_id end,
        case when v_publish then 'published' else 'draft' end,
        case when v_publish then null else p_home_id end,
        p_content ->> 'name', v_user_id, v_user_id,
        case when v_publish then pg_catalog.now() end,
        p_content #>> '{source,url}', p_content #>> '{source,name}'
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

-- Editing locks -------------------------------------------------------------------------------------

-- S24's acquire_recipe_lock, seen from a viewing context (p_home_id; null: where it lives). A lock
-- held by someone else names them only when they are a member of the viewing Home and the caller
-- is too (held_by_member); otherwise it says only that someone else is editing.
drop function public.acquire_recipe_lock(uuid, uuid, boolean);
create function public.acquire_recipe_lock(
  p_recipe_id uuid, p_token uuid, p_take_over boolean default false, p_home_id uuid default null
) returns table (
  outcome text, revision integer, expires_at timestamptz, held_by_me boolean, held_by_member uuid
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_lock private.recipe_edit_locks;
    v_context uuid;
  begin
    if p_recipe_id is null or p_token is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null or not private.recipe_visible_in(v_recipe, p_home_id, v_user_id) then
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
      v_context := coalesce(p_home_id, v_recipe.owner_home_id);
      return query select 'locked', v_recipe.revision, v_lock.expires_at, v_lock.user_id = v_user_id,
        case when private.is_home_member(v_context, v_user_id)
          then private.member_ref(v_context, v_lock.user_id) end;
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

-- Deleting ------------------------------------------------------------------------------------------

-- A fingerprint of what a delete affects now: the recipe's revision and its shares (active or
-- paused, with their edit choice). A delete whose review saw another fingerprint is stale.
create function private.recipe_impact_token(p_recipe private.recipes) returns text
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.md5(p_recipe.id::text || ':' || p_recipe.revision::text || ':' || coalesce((
    select pg_catalog.string_agg(s.home_id::text || case when s.can_edit then 'e' else 'v' end, ','
      order by s.home_id)
    from private.recipe_shares s where s.recipe_id = p_recipe.id), ''));
  $$;

-- What deleting a recipe would affect, for someone who may delete it (spec "impact-reviewed
-- deletion"): its origin, the Homes it is shared with (names: the caller may manage those shares,
-- since only origin recipe managers delete a shared recipe), how many people marked it as a
-- favorite anywhere (a count only), and whether someone else is editing it now. The token goes back
-- with the delete. Meal-plan impact is added by S27. Outcomes: 'ok' (with the impact), 'not_found',
-- 'not_permitted'.
create function public.recipe_delete_impact(p_recipe_id uuid)
returns table (outcome text, impact jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_see_recipe(v_recipe, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    if not private.can_delete_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    return query select 'ok', pg_catalog.jsonb_build_object(
      'token', private.recipe_impact_token(v_recipe),
      'status', v_recipe.status,
      'homeId', v_recipe.owner_home_id,
      'shares', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'homeId', s.home_id, 'homeName', h.name, 'canEdit', s.can_edit)
          order by h.name, s.home_id)
        from private.recipe_shares s join public.homes h on h.id = s.home_id
        where s.recipe_id = v_recipe.id and s.suspended_at is null), '[]'::jsonb),
      'favoriteCount', (select count(*) from private.recipe_favorites f where f.recipe_id = v_recipe.id),
      'beingEdited', exists (
        select 1 from private.recipe_edit_locks l
        where l.recipe_id = v_recipe.id and l.user_id <> v_user_id and l.expires_at > pg_catalog.now())
    );
  end
  $$;

-- S24's delete_recipe with the impact review. A shared recipe needs the token of a review
-- (recipe_delete_impact) that still matches: 'impact_review_required' without one, 'stale_impact'
-- when the recipe or its shares changed since (any recipe sent with a token is checked the same way).
-- Its shares are paused, not removed: a restore brings them back paused, for a manager to reinstate.
-- Outcomes: 'deleted' (with the entry), 'locked', 'impact_review_required', 'stale_impact',
-- 'not_found', 'not_permitted'.
drop function public.delete_recipe(uuid);
create function public.delete_recipe(p_recipe_id uuid, p_impact_token text default null)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_home_id uuid;
    v_shares integer;
  begin
    if p_recipe_id is null or pg_catalog.char_length(coalesce(p_impact_token, '')) > 64 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    -- Seen only from a Home it is shared with: a destination never deletes it.
    if not private.can_delete_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    -- The share rows are the recipe's: locked after the recipe row (lock order).
    perform 1 from private.recipe_shares s where s.recipe_id = v_recipe.id order by s.home_id for update;
    select count(*) into v_shares from private.recipe_shares s where s.recipe_id = v_recipe.id;
    if v_shares > 0 and p_impact_token is null then
      return query select 'impact_review_required', null::uuid;
      return;
    end if;
    if p_impact_token is not null and p_impact_token <> private.recipe_impact_token(v_recipe) then
      return query select 'stale_impact', null::uuid;
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
    update private.recipe_shares s set suspended_at = pg_catalog.now()
      where s.recipe_id = v_recipe.id and s.suspended_at is null;
    update private.recipes r set deleted_at = pg_catalog.now() where r.id = v_recipe.id;
    perform private.audit_recipe('recipe.deleted', v_recipe.owner_home_id, v_recipe.id,
      pg_catalog.jsonb_build_object('shares', v_shares));
    -- Each destination's own record says only that the recipe shared with it was deleted.
    for v_home_id in
      select s.home_id from private.recipe_shares s where s.recipe_id = v_recipe.id order by s.home_id
    loop
      perform private.audit_recipe('recipe.shared_deleted', v_home_id, v_recipe.id);
    end loop;
    return query select 'deleted',
      private.trash_move(v_user_id, 'recipes', 'recipe', v_recipe.id, v_recipe.owner_user_id,
        v_recipe.owner_home_id, v_recipe.name,
        case when v_recipe.cover_file_id is not null then array[v_recipe.cover_file_id] else '{}'::uuid[] end);
  end
  $$;

-- Sharing -------------------------------------------------------------------------------------------

-- Where a recipe is shared and where it could be shared, for a recipe manager of its origin (anyone
-- else: no rows). state: 'active', 'paused' (since the recipe was deleted; reinstate or remove) or
-- 'available' (a Home the caller belongs to that it is not shared with). Never the origin itself.
create function public.list_recipe_shares(p_recipe_id uuid)
returns table (home_id uuid, home_name text, state text, can_edit boolean, shared_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_share_recipe(v_recipe, v_user_id) then
      return;
    end if;
    return query
      select s.home_id, h.name,
        case when s.suspended_at is null then 'active' else 'paused' end, s.can_edit, s.shared_at
      from private.recipe_shares s join public.homes h on h.id = s.home_id
      where s.recipe_id = v_recipe.id
      union all
      select h.id, h.name, 'available', false, null::timestamptz
      from public.home_memberships m join public.homes h on h.id = m.home_id
      where m.user_id = v_user_id and h.id is distinct from v_recipe.owner_home_id
        and not exists (select 1 from private.recipe_shares s where s.recipe_id = v_recipe.id and s.home_id = h.id)
      order by 3, 2, 1;
  end
  $$;

-- Shares a published recipe with a Home the caller belongs to, view-only or letting that Home's
-- recipe managers edit it too, or changes that choice; reinstates a paused share. A recipe manager of
-- its origin only, and never into its own origin. Set-to-state, so a repeat answers 'unchanged'.
-- Outcomes: 'shared', 'updated', 'unchanged', 'destination_unavailable' (not a Home the caller
-- belongs to, or its origin), 'not_found', 'not_permitted'.
create function public.share_recipe(p_recipe_id uuid, p_home_id uuid, p_can_edit boolean)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_share private.recipe_shares;
    v_member boolean;
  begin
    if p_recipe_id is null or p_home_id is null or p_can_edit is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The destination membership first (lock order), then the recipe.
    v_member := private.hold_membership(p_home_id, v_user_id);
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return 'not_found';
    end if;
    if not private.can_share_recipe(v_recipe, v_user_id) then
      return 'not_permitted';
    end if;
    if not v_member or p_home_id is not distinct from v_recipe.owner_home_id then
      return 'destination_unavailable';
    end if;
    select * into v_share from private.recipe_shares s
      where s.recipe_id = v_recipe.id and s.home_id = p_home_id for update;
    if v_share.recipe_id is not null and v_share.suspended_at is null then
      if v_share.can_edit = p_can_edit then
        return 'unchanged';
      end if;
      update private.recipe_shares s set can_edit = p_can_edit
        where s.recipe_id = v_recipe.id and s.home_id = p_home_id;
      perform private.end_recipe_locks_without_rights(v_recipe.id);
      perform private.audit_recipe('recipe.share_changed', v_recipe.owner_home_id, v_recipe.id,
        pg_catalog.jsonb_build_object('canEdit', p_can_edit));
      perform private.audit_recipe('recipe.share_changed', p_home_id, v_recipe.id,
        pg_catalog.jsonb_build_object('canEdit', p_can_edit));
      return 'updated';
    end if;
    insert into private.recipe_shares as s (recipe_id, home_id, can_edit, shared_by, shared_at)
      values (v_recipe.id, p_home_id, p_can_edit, v_user_id, pg_catalog.now())
      on conflict (recipe_id, home_id) do update
        set can_edit = excluded.can_edit, shared_by = excluded.shared_by,
          shared_at = excluded.shared_at, suspended_at = null;
    perform private.audit_recipe('recipe.shared', v_recipe.owner_home_id, v_recipe.id,
      pg_catalog.jsonb_build_object('canEdit', p_can_edit));
    perform private.audit_recipe('recipe.shared_in', p_home_id, v_recipe.id,
      pg_catalog.jsonb_build_object('canEdit', p_can_edit));
    return 'shared';
  end
  $$;

-- Removes a recipe's share with one Home (active or paused): a recipe manager of its origin, or a
-- recipe manager of that Home ("Remove from this Home"). Never deletes the recipe or other shares.
-- That Home's favorites of it go, and so do the editing locks of people who may no longer edit it.
-- Outcomes: 'unshared', 'not_shared' (nothing to remove: a repeat), 'not_found', 'not_permitted'.
create function public.unshare_recipe(p_recipe_id uuid, p_home_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_origin boolean;
    v_destination boolean;
  begin
    if p_recipe_id is null or p_home_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.hold_membership(p_home_id, v_user_id);
    v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
    if v_recipe.id is null then
      return 'not_found';
    end if;
    v_origin := private.can_share_recipe(v_recipe, v_user_id);
    v_destination := private.recipe_visible_in(v_recipe, p_home_id, v_user_id)
      and coalesce(v_recipe.owner_home_id <> p_home_id, true)
      and private.has_home_capability(p_home_id, v_user_id, 'manageHomeRecipes');
    if not v_origin and not v_destination then
      return 'not_permitted';
    end if;
    delete from private.recipe_shares s where s.recipe_id = v_recipe.id and s.home_id = p_home_id;
    if not found then
      return 'not_shared';
    end if;
    delete from private.recipe_favorites f where f.recipe_id = v_recipe.id and f.context_home_id = p_home_id;
    perform private.end_recipe_locks_without_rights(v_recipe.id);
    perform private.audit_recipe('recipe.unshared', v_recipe.owner_home_id, v_recipe.id);
    perform private.audit_recipe('recipe.unshared', p_home_id, v_recipe.id);
    return 'unshared';
  end
  $$;

-- Reading in a context ------------------------------------------------------------------------------

-- S24's list_recipes, with the recipes shared into a Home listed there too (shared_in true). Ratings
-- are the viewing context's.
drop function public.list_recipes(uuid, text, text[], boolean, text, integer, integer);
create function public.list_recipes(
  p_home_id uuid default null, p_query text default null, p_tags text[] default null,
  p_favorites boolean default false, p_sort text default 'name_asc', p_limit integer default 24,
  p_offset integer default 0
) returns table (
  id uuid, name text, cover_file_id uuid, tags text[], servings integer, prep_minutes integer,
  cook_minutes integer, matched_ingredient text, favorite boolean, my_rating smallint,
  rating_average numeric, rating_count integer, published_at timestamptz, updated_at timestamptz,
  revision integer, shared_in boolean, total_count integer
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
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id
            or r.id = any (array(select s.recipe_id from private.recipe_shares s
              where s.home_id = p_home_id and s.suspended_at is null)))
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
        g.average, g.rating_count, p.published_at, p.updated_at, p.revision,
        p_home_id is not null and p.owner_home_id is distinct from p_home_id, p.total
      from page p
      cross join lateral private.recipe_rating(p.id,
        case when p_home_id is null then p.owner_user_id end, p_home_id) g
      order by
        case when p_sort = 'name_desc' then p.name_key end desc,
        case when p_sort = 'added_desc' then p.published_at end desc,
        case when p_sort = 'added_asc' then p.published_at end asc,
        case when p_sort = 'updated_desc' then p.updated_at end desc,
        case when p_sort = 'updated_asc' then p.updated_at end asc,
        p.name_key asc, p.id asc;
  end
  $$;

-- S24's list_recipe_tags, counting the recipes shared into a Home too.
create or replace function public.list_recipe_tags(p_home_id uuid default null)
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
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id
            or r.id = any (array(select s.recipe_id from private.recipe_shares s
              where s.home_id = p_home_id and s.suspended_at is null)))
          and r.status = 'published' and r.deleted_at is null
      ) t
      group by t.tag_key
      order by t.tag_key
      limit 500;
  end
  $$;

-- S24's recipe_widget, with the recipes shared into a Home and the viewing context's ratings.
create or replace function public.recipe_widget(
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
        cross join lateral private.recipe_rating(r.id,
          case when p_home_id is null then r.owner_user_id end, p_home_id) g
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id
            or r.id = any (array(select s.recipe_id from private.recipe_shares s
              where s.home_id = p_home_id and s.suspended_at is null)))
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

-- S24's get_recipe, seen from a viewing context (p_home_id; null: where it lives), or null when it
-- is not the caller's to see from there. Seen from a Home it is shared with (sharedIn), nothing names
-- its origin or its people: who added and changed it shows only "you", and the lock names its holder
-- only when they belong to the viewing Home. Ratings and the favorite are the viewing context's.
drop function public.get_recipe(uuid);
create function public.get_recipe(p_recipe_id uuid, p_home_id uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_lock private.recipe_edit_locks;
    v_rating record;
    v_context uuid;
    v_shared_in boolean;
    v_people uuid;
    v_can_edit boolean;
    v_can_share boolean;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.recipe_visible_in(v_recipe, p_home_id, v_user_id) then
      return null;
    end if;
    v_context := coalesce(p_home_id, v_recipe.owner_home_id);
    v_shared_in := p_home_id is not null and v_recipe.owner_home_id is distinct from p_home_id;
    -- Whose memberships name people: the origin's, never from a destination.
    v_people := case when v_shared_in then null else v_context end;
    v_can_edit := private.can_edit_recipe(v_recipe, v_user_id);
    v_can_share := private.can_share_recipe(v_recipe, v_user_id);
    select * into v_lock from private.recipe_edit_locks l
      where l.recipe_id = v_recipe.id and l.expires_at > pg_catalog.now();
    select * into v_rating from private.recipe_context_rating(v_recipe, p_home_id);
    return pg_catalog.jsonb_build_object(
      'id', v_recipe.id,
      'status', v_recipe.status,
      'homeId', case when v_shared_in then null else v_recipe.owner_home_id end,
      'contextHomeId', p_home_id,
      'sharedIn', v_shared_in,
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
      'source', case when v_recipe.source_url is not null then pg_catalog.jsonb_build_object(
        'url', v_recipe.source_url, 'name', v_recipe.source_name) end,
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
        'member', private.member_ref(v_people, v_recipe.created_by)),
      'updatedAt', v_recipe.updated_at,
      'updatedBy', pg_catalog.jsonb_build_object('me', coalesce(v_recipe.updated_by = v_user_id, false),
        'member', private.member_ref(v_people, v_recipe.updated_by)),
      'publishedAt', v_recipe.published_at,
      'favorite', v_recipe.status = 'published' and exists (
        select 1 from private.recipe_favorites f where f.user_id = v_user_id and f.recipe_id = v_recipe.id
          and f.context_home_id is not distinct from v_context),
      'rating', pg_catalog.jsonb_build_object(
        'mine', (select rt.stars from private.recipe_ratings rt
          where rt.recipe_id = v_recipe.id and rt.user_id = v_user_id and v_recipe.status = 'published'),
        'average', case when v_recipe.status = 'published' then v_rating.average end,
        'count', case when v_recipe.status = 'published' then v_rating.rating_count else 0 end),
      'lock', case when v_lock.recipe_id is not null then pg_catalog.jsonb_build_object(
        'mine', v_lock.user_id = v_user_id,
        'member', private.member_ref(v_context, v_lock.user_id),
        'expiresAt', v_lock.expires_at) end,
      -- Whether it is shared at all (never where): editors are told a save changes it everywhere.
      'isShared', v_shared_in or private.recipe_has_shares(v_recipe.id),
      -- How many Homes it is shared with: for those who manage its shares only.
      'shareCount', case when v_can_share then (
        select count(*) from private.recipe_shares s where s.recipe_id = v_recipe.id and s.suspended_at is null)
        else 0 end,
      'can', pg_catalog.jsonb_build_object(
        'edit', v_can_edit,
        'delete', not v_shared_in and private.can_delete_recipe(v_recipe, v_user_id),
        'share', not v_shared_in and v_can_share,
        'unshareHere', v_shared_in and private.has_home_capability(p_home_id, v_user_id, 'manageHomeRecipes'),
        'rate', v_recipe.status = 'published',
        'favorite', v_recipe.status = 'published',
        'publish', v_recipe.status = 'draft')
    );
  end
  $$;

-- Ratings and favorites in a context ----------------------------------------------------------------

-- S24's set_recipe_rating, from a viewing context (p_home_id; null: where it lives): the one rating
-- per person and recipe, and the average and count of that context afterwards.
drop function public.set_recipe_rating(uuid, integer);
create function public.set_recipe_rating(
  p_recipe_id uuid default null, p_stars integer default null, p_home_id uuid default null
) returns table (outcome text, mine integer, average numeric, rating_count integer)
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
    if not private.recipe_visible_in(v_recipe, p_home_id, v_user_id) or v_recipe.status <> 'published' then
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
    select * into v_rating from private.recipe_context_rating(v_recipe, p_home_id);
    return query select case when p_stars is null then 'cleared' else 'saved' end, p_stars,
      v_rating.average, v_rating.rating_count;
  end
  $$;

-- S24's set_recipe_favorite, in a viewing context (p_home_id; null: where it lives). A favorite in
-- one Home never shows in another.
drop function public.set_recipe_favorite(uuid, boolean);
create function public.set_recipe_favorite(p_recipe_id uuid, p_favorite boolean, p_home_id uuid default null)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_context uuid;
  begin
    if p_recipe_id is null or p_favorite is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id for share;
    if not private.recipe_visible_in(v_recipe, p_home_id, v_user_id) or v_recipe.status <> 'published' then
      return 'not_found';
    end if;
    v_context := coalesce(p_home_id, v_recipe.owner_home_id);
    if p_favorite then
      insert into private.recipe_favorites (user_id, recipe_id, context_home_id)
        values (v_user_id, v_recipe.id, v_context)
        on conflict do nothing;
    else
      delete from private.recipe_favorites f
        where f.user_id = v_user_id and f.recipe_id = v_recipe.id
          and f.context_home_id is not distinct from v_context;
    end if;
    return 'saved';
  end
  $$;

-- Import ------------------------------------------------------------------------------------------------

-- Takes one of the caller's URL import slots (imports_per_hour), before the server fetches anything.
-- Serialized per account so two at once cannot both take the last one. Outcomes: 'ok',
-- 'rate_limited'.
create function public.begin_recipe_import() returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('recipe-import:' || v_user_id::text, 0));
    delete from private.recipe_import_attempts a
      where a.user_id = v_user_id and a.created_at < pg_catalog.now() - interval '1 day';
    if (select count(*) from private.recipe_import_attempts a
        where a.user_id = v_user_id and a.created_at > pg_catalog.now() - interval '1 hour')
       >= private.recipe_limit('imports_per_hour') then
      return 'rate_limited';
    end if;
    insert into private.recipe_import_attempts (user_id) values (v_user_id);
    return 'ok';
  end
  $$;

-- Recipes in a context (the Personal space or a Home the caller belongs to) that an import may
-- duplicate: the same source URL, or the same name (compared like search), among the published
-- recipes seen there and the caller's own drafts. At most 'duplicates' rows, source matches first.
-- 42501 for a Home the caller is not in.
create function public.find_recipe_duplicates(
  p_home_id uuid default null, p_name text default null, p_source_url text default null
) returns table (id uuid, name text, status text, match text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_name_key text;
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if pg_catalog.char_length(coalesce(p_name, '')) > 4 * private.recipe_limit('name')
       or pg_catalog.char_length(coalesce(p_source_url, '')) > private.recipe_limit('source_url') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_name_key := nullif(private.recipe_fold(coalesce(p_name, '')), '');
    return query
      select r.id, r.name, r.status,
        case when p_source_url is not null and r.source_url = p_source_url then 'source' else 'name' end
      from private.recipes r
      where r.deleted_at is null
        and (
          (r.status = 'draft' and r.owner_user_id = v_user_id)
          or (r.status = 'published' and (
            (p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id
            or r.id = any (array(select s.recipe_id from private.recipe_shares s
              where s.home_id = p_home_id and s.suspended_at is null))))
        )
        and ((p_source_url is not null and r.source_url = p_source_url)
          or (v_name_key is not null and r.name_key = v_name_key))
      order by 4 desc, r.status desc, r.updated_at desc, r.id
      limit private.recipe_limit('duplicates');
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_recipe', 'acquire_recipe_lock', 'delete_recipe', 'recipe_delete_impact',
      'list_recipe_shares', 'share_recipe', 'unshare_recipe', 'list_recipes', 'list_recipe_tags',
      'recipe_widget', 'get_recipe', 'set_recipe_rating', 'set_recipe_favorite',
      'begin_recipe_import', 'find_recipe_duplicates'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like '%recipe%' or p.proname = 'hold_share_memberships')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
