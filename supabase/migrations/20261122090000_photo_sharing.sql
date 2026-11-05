-- S36: photo sharing and widgets (brief plans/steps/S36-brief.md; ADR 0046; Modules.md §4.7).
--
-- An album can be shared with other Homes, view or contribute, without copying anything: the album,
-- its photos and their files stay where they are, and each read checks again who may see what. A
-- photo is visible to a person when they can see its own library, or when it is in an album they can
-- see now and still belongs there (see photo_in_album_visible). Removing a share, or an album from a
-- Home, only ends access and memberships; it never deletes a photo. The photo widget reads through
-- resolve_photo_widget, with the same rules.
--
-- Defaults (the spec leaves them to a supporting Photos specification; brief "Open in the spec"):
-- a personal album is shared by its owner, a Home album by the Owner and Administrators granted
-- manageHomePhotos; destinations are Homes the sharer belongs to now; contribute lets every current
-- member of that Home add photos they may share.

-- Limits --------------------------------------------------------------------------------------------------

-- apps/web/src/photos/schema.ts uses the same numbers.
create or replace function private.photo_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'album_name' then 80
    when 'albums' then 200              -- albums per library that are not in the trash
    when 'album_photos' then 2000       -- photos per album
    when 'page' then 60                 -- photos in one list answer
    when 'max_offset' then 100000
    when 'batch' then 100               -- photo ids in one request
    when 'max_side' then 12000
    when 'max_pixels' then 50000000
    when 'album_shares' then 20         -- Homes one album is shared with (S36)
    when 'widget_photos' then 50        -- hand-picked photos in one widget (S36)
    when 'widget_album' then 100        -- newest photos of an album a widget shows (S36)
  end;
  $$;

-- Shares -------------------------------------------------------------------------------------------------

create table private.photo_album_shares (
  album_id uuid not null references private.photo_albums (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  access text not null check (access in ('view', 'contribute')),
  shared_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (album_id, home_id)
);
create index photo_album_shares_home on private.photo_album_shares (home_id);

alter table private.photo_album_shares enable row level security;
revoke all on table private.photo_album_shares from public, anon, authenticated, service_role;

-- Access --------------------------------------------------------------------------------------------------

-- S35's rule, now also called for people outside the album's Home (share recipients): never null.
create or replace function private.can_change_photo_item(
  p_owner_user_id uuid, p_owner_home_id uuid, p_created_by uuid, p_user_id uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (
      p_owner_home_id is not null
      and (
        coalesce(private.photo_access(p_owner_home_id, p_user_id) = 'manage', false)
        or (coalesce(p_created_by = p_user_id, false)
          and private.photo_access(p_owner_home_id, p_user_id) is not null)
      )
    )
  ), false);
  $$;

-- The best access a person has to an album through the Homes they belong to now: 'contribute',
-- 'view' or null.
create function private.photo_album_share_access(p_album_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when pg_catalog.bool_or(s.access = 'contribute') then 'contribute'
    when pg_catalog.count(*) > 0 then 'view'
  end
  from private.photo_album_shares s
  join public.home_memberships m on m.home_id = s.home_id and m.user_id = p_user_id
  where s.album_id = p_album_id and p_user_id is not null;
  $$;

-- Whether a person may see an album now: through its own library, or a share with a Home they are in.
create function private.can_see_photo_album(p_album private.photo_albums, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_album.id is not null and p_album.deleted_at is null and p_user_id is not null and (
    private.can_see_photo_library(p_album.owner_user_id, p_album.owner_home_id, p_user_id)
    or private.photo_album_share_access(p_album.id, p_user_id) is not null
  )), false);
  $$;

-- Whether a photo still belongs in an album's view (for everyone who sees the album): a photo of the
-- album's own library; a personal photo while its owner can still see the album; a Home's photo while
-- that Home still has a share. Otherwise the membership stays but shows nowhere.
create function private.photo_in_album_visible(p_album private.photo_albums, p_photo private.photos)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_photo.id is not null and p_photo.deleted_at is null and (
    (p_photo.owner_user_id is not distinct from p_album.owner_user_id
      and p_photo.owner_home_id is not distinct from p_album.owner_home_id)
    or (p_photo.owner_user_id is not null and private.can_see_photo_album(p_album, p_photo.owner_user_id))
    or (p_photo.owner_home_id is not null and exists (
      select 1 from private.photo_album_shares s
      where s.album_id = p_album.id and s.home_id = p_photo.owner_home_id))
  )), false);
  $$;

-- Whether a person may see a photo now: its own library, or an album they can see that shows it.
create function private.can_see_photo(p_photo private.photos, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_photo.id is not null and p_photo.deleted_at is null and p_user_id is not null and (
    private.can_see_photo_library(p_photo.owner_user_id, p_photo.owner_home_id, p_user_id)
    or exists (
      select 1 from private.photo_album_items i
      join private.photo_albums a on a.id = i.album_id
      where i.photo_id = p_photo.id
        and private.can_see_photo_album(a, p_user_id)
        and private.photo_in_album_visible(a, p_photo))
  )), false);
  $$;

-- Who may change an album's shares: a personal album's owner; for a Home album, its photo managers.
create function private.can_share_photo_album(p_album private.photo_albums, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_user_id is not null and p_album.deleted_at is null and (
    coalesce(p_album.owner_user_id = p_user_id, false)
    or (p_album.owner_home_id is not null and private.photo_access(p_album.owner_home_id, p_user_id) = 'manage')
  )), false);
  $$;

-- Whether an album belongs on a library page: the person's own personal album (p_home_id null), or a
-- Home's own album or one shared with that Home, for a current member.
create function private.photo_album_in_context(p_album private.photo_albums, p_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_album.id is not null and p_album.deleted_at is null and p_user_id is not null and case
    when p_home_id is null then coalesce(p_album.owner_user_id = p_user_id, false)
    else private.photo_access(p_home_id, p_user_id) is not null and (
      coalesce(p_album.owner_home_id = p_home_id, false)
      or exists (select 1 from private.photo_album_shares s
        where s.album_id = p_album.id and s.home_id = p_home_id))
  end), false);
  $$;

-- Whether a person may add photos to an album at all: its editor (S35) or a contributor by share.
create function private.can_contribute_to_photo_album(p_album private.photo_albums, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_album.deleted_at is null and (
    private.can_change_photo_item(p_album.owner_user_id, p_album.owner_home_id, p_album.created_by, p_user_id)
    or private.photo_album_share_access(p_album.id, p_user_id) = 'contribute'
  )), false);
  $$;

-- Whether a person may add this photo to this album: a photo of the album's own library (its editor);
-- their own personal photo (editor or contributor); or a photo of a Home the album is shared with
-- that they uploaded or manage there (editor, or contributor when that Home's share is contribute).
create function private.can_add_photo_to_album(
  p_album private.photo_albums, p_photo private.photos, p_user_id uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((p_photo.id is not null and p_photo.deleted_at is null and p_album.deleted_at is null
    and private.can_see_photo_library(p_photo.owner_user_id, p_photo.owner_home_id, p_user_id)
    and (
      (p_photo.owner_user_id is not distinct from p_album.owner_user_id
        and p_photo.owner_home_id is not distinct from p_album.owner_home_id
        and private.can_change_photo_item(p_album.owner_user_id, p_album.owner_home_id, p_album.created_by,
          p_user_id))
      or (coalesce(p_photo.owner_user_id = p_user_id, false)
        and private.can_contribute_to_photo_album(p_album, p_user_id))
      or (p_photo.owner_home_id is not null
        and p_photo.owner_home_id is distinct from p_album.owner_home_id
        and private.can_change_photo_item(null, p_photo.owner_home_id, p_photo.created_by, p_user_id)
        and exists (
          select 1 from private.photo_album_shares s
          where s.album_id = p_album.id and s.home_id = p_photo.owner_home_id
            and (s.access = 'contribute'
              or private.can_change_photo_item(p_album.owner_user_id, p_album.owner_home_id,
                p_album.created_by, p_user_id))))
    )), false);
  $$;

-- Whether a person may take this photo out of this album: the album's editor, or someone who can see
-- the album and added the photo or may change it in its own library.
create function private.can_remove_photo_from_album(
  p_album private.photo_albums, p_photo private.photos, p_added_by uuid, p_user_id uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((private.can_change_photo_item(p_album.owner_user_id, p_album.owner_home_id, p_album.created_by,
      p_user_id)
    or (private.can_see_photo_album(p_album, p_user_id) and (
      coalesce(p_added_by = p_user_id, false)
      or private.can_change_photo_item(p_photo.owner_user_id, p_photo.owner_home_id, p_photo.created_by,
        p_user_id)))), false);
  $$;

-- Ends one share: the share goes, and so do the memberships that only it allowed (that Home's photos,
-- and personal photos whose owner can no longer see the album). No photo is deleted.
create function private.end_photo_album_share(p_album_id uuid, p_home_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_album private.photo_albums;
  begin
    delete from private.photo_album_shares s where s.album_id = p_album_id and s.home_id = p_home_id;
    delete from private.photo_album_items i
      using private.photos p
      where i.album_id = p_album_id and p.id = i.photo_id and p.owner_home_id = p_home_id;
    select * into v_album from private.photo_albums a where a.id = p_album_id;
    delete from private.photo_album_items i
      using private.photos p
      where i.album_id = p_album_id and p.id = i.photo_id and p.owner_user_id is not null
        and p.owner_user_id is distinct from v_album.owner_user_id
        and not private.can_see_photo_album(v_album, p.owner_user_id);
  end
  $$;

create function private.photo_home_name(p_home_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select h.name from public.homes h where h.id = p_home_id;
  $$;

-- Reading --------------------------------------------------------------------------------------------------

-- A library page (S35, extended): the library's own albums, the albums shared with this Home (Home
-- pages), the albums the person may add this library's photos to, the selected album with what the
-- person may do in it, and one page of photos. An album may be the library's own or, on a Home's
-- page, one shared with that Home; in an album only the photos that still belong there show. Null for
-- a Home the person is not in and an album that is not on this page.
create or replace function public.list_photo_library(p_home_id uuid, p_album_id uuid, p_offset integer)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_manage boolean;
    v_album private.photo_albums;
    v_album_json jsonb;
    v_offset integer := coalesce(p_offset, 0);
    v_photos jsonb;
    v_total integer;
  begin
    if v_offset < 0 or v_offset > private.photo_limit('max_offset') then
      raise exception 'invalid offset' using errcode = '22023';
    end if;
    if p_home_id is not null and private.photo_access(p_home_id, v_user_id) is null then
      return null;
    end if;
    v_manage := p_home_id is null or private.photo_access(p_home_id, v_user_id) = 'manage';

    if p_album_id is not null then
      select * into v_album from private.photo_albums a where a.id = p_album_id;
      if not found or not private.photo_album_in_context(v_album, p_home_id, v_user_id)
         or not private.can_see_photo_album(v_album, v_user_id) then
        return null;
      end if;
      v_album_json := pg_catalog.jsonb_build_object(
        'id', v_album.id,
        'name', v_album.name,
        'revision', v_album.revision,
        'owned', v_album.owner_user_id is not distinct from v_owner_user
          and v_album.owner_home_id is not distinct from p_home_id,
        'ownerHomeName', private.photo_home_name(v_album.owner_home_id),
        'access', case
          when private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
            v_album.created_by, v_user_id) then 'edit'
          else coalesce(private.photo_album_share_access(v_album.id, v_user_id), 'view') end,
        'canContribute', private.can_contribute_to_photo_album(v_album, v_user_id),
        'canShare', private.can_share_photo_album(v_album, v_user_id),
        'canRemoveShare', p_home_id is not null
          and v_album.owner_home_id is distinct from p_home_id
          and (coalesce(private.photo_access(p_home_id, v_user_id) = 'manage', false)
            or private.can_share_photo_album(v_album, v_user_id)),
        -- Only the album's own library learns how many Homes see it.
        'shareCount', case when v_album.owner_user_id is not distinct from v_owner_user
            and v_album.owner_home_id is not distinct from p_home_id then (
          select pg_catalog.count(*) from private.photo_album_shares s
          where s.album_id = v_album.id) else 0 end,
        'shares', case when private.can_share_photo_album(v_album, v_user_id) then (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'homeId', s.home_id, 'homeName', h.name, 'access', s.access) order by h.name, s.home_id), '[]')
          from private.photo_album_shares s join public.homes h on h.id = s.home_id
          where s.album_id = v_album.id) else '[]'::jsonb end);

      select pg_catalog.count(*) into v_total
        from private.photo_album_items i join private.photos p on p.id = i.photo_id
        where i.album_id = v_album.id and private.photo_in_album_visible(v_album, p);
      select coalesce(pg_catalog.jsonb_agg(private.photo_json(x.ph, v_user_id) || pg_catalog.jsonb_build_object(
          'canRemove', private.can_remove_photo_from_album(v_album, x.ph, x.added_by, v_user_id))
          order by (x.ph).created_at desc, (x.ph).id), '[]')
        into v_photos
        from (
          select p as ph, i.added_by from private.photo_album_items i
            join private.photos p on p.id = i.photo_id
            where i.album_id = v_album.id and private.photo_in_album_visible(v_album, p)
            order by p.created_at desc, p.id
            limit private.photo_limit('page') offset v_offset
        ) x;
    else
      select pg_catalog.count(*) into v_total from private.photos p
        where p.deleted_at is null
          and p.owner_user_id is not distinct from v_owner_user
          and p.owner_home_id is not distinct from p_home_id;
      select coalesce(pg_catalog.jsonb_agg(private.photo_json(x, v_user_id) order by x.created_at desc, x.id), '[]')
        into v_photos
        from (
          select p.* from private.photos p
            where p.deleted_at is null
              and p.owner_user_id is not distinct from v_owner_user
              and p.owner_home_id is not distinct from p_home_id
            order by p.created_at desc, p.id
            limit private.photo_limit('page') offset v_offset
        ) x;
    end if;

    return pg_catalog.jsonb_build_object(
      'homeId', p_home_id,
      'canUpload', true,
      'canManage', v_manage,
      'albumId', p_album_id,
      'albumName', v_album.name,
      'album', v_album_json,
      'total', v_total,
      'photos', v_photos,
      'albums', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'name', a.name, 'revision', a.revision,
          'photoCount', (select pg_catalog.count(*) from private.photo_album_items i
            join private.photos p on p.id = i.photo_id
            where i.album_id = a.id and private.photo_in_album_visible(a, p)),
          'coverPhotoId', (select p.id from private.photo_album_items i
            join private.photos p on p.id = i.photo_id
            where i.album_id = a.id and private.photo_in_album_visible(a, p)
            order by i.added_at desc, p.id limit 1),
          'canEdit', private.can_change_photo_item(a.owner_user_id, a.owner_home_id, a.created_by, v_user_id),
          'shareCount', (select pg_catalog.count(*) from private.photo_album_shares s where s.album_id = a.id)
        ) order by a.created_at, a.id), '[]')
        from private.photo_albums a
        where a.deleted_at is null
          and a.owner_user_id is not distinct from v_owner_user
          and a.owner_home_id is not distinct from p_home_id
      ),
      -- Albums of other libraries shared with this Home (Home pages only).
      'sharedAlbums', case when p_home_id is null then '[]'::jsonb else (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'name', a.name,
          'access', s.access,
          'ownerHomeName', private.photo_home_name(a.owner_home_id),
          'photoCount', (select pg_catalog.count(*) from private.photo_album_items i
            join private.photos p on p.id = i.photo_id
            where i.album_id = a.id and private.photo_in_album_visible(a, p))
        ) order by a.name, a.id), '[]')
        from private.photo_album_shares s
        join private.photo_albums a on a.id = s.album_id and a.deleted_at is null
        where s.home_id = p_home_id
      ) end,
      -- Albums the person may add photos of this library to. 'shared' means people outside this
      -- library will see what is added (the person is told before adding).
      'targets', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'name', a.name,
          'ownerHomeName', private.photo_home_name(a.owner_home_id),
          'shared', not (a.owner_user_id is not distinct from v_owner_user
              and a.owner_home_id is not distinct from p_home_id)
            or exists (select 1 from private.photo_album_shares s where s.album_id = a.id)
        ) order by (a.owner_user_id is not distinct from v_owner_user
              and a.owner_home_id is not distinct from p_home_id) desc, a.name, a.id), '[]')
        from private.photo_albums a
        where a.deleted_at is null
          -- Candidates first: the person's own albums, their Homes' albums, albums shared with their
          -- Homes (indexed), before the per-album checks.
          and (a.owner_user_id = v_user_id
            or a.owner_home_id in (select m.home_id from public.home_memberships m where m.user_id = v_user_id)
            or a.id in (select s.album_id from private.photo_album_shares s
              join public.home_memberships m on m.home_id = s.home_id and m.user_id = v_user_id))
          and private.can_see_photo_album(a, v_user_id)
          and case
            -- Personal photos: any album the person edits or contributes to.
            when p_home_id is null then private.can_contribute_to_photo_album(a, v_user_id)
            -- This Home's photos: its own albums the person edits, and albums shared with it that
            -- the person contributes to or edits.
            else (coalesce(a.owner_home_id = p_home_id, false)
                and private.can_change_photo_item(a.owner_user_id, a.owner_home_id, a.created_by, v_user_id))
              or exists (select 1 from private.photo_album_shares s
                where s.album_id = a.id and s.home_id = p_home_id
                  and (s.access = 'contribute' or private.can_change_photo_item(a.owner_user_id,
                    a.owner_home_id, a.created_by, v_user_id)))
          end
      )
    );
  end
  $$;

-- One photo and the albums the person can see that show it. Null when the person may not see it.
create or replace function public.get_photo(p_photo_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_photo private.photos;
  begin
    select * into v_photo from private.photos p where p.id = p_photo_id and p.deleted_at is null;
    if not found or not private.can_see_photo(v_photo, v_user_id) then
      return null;
    end if;
    return private.photo_json(v_photo, v_user_id) || pg_catalog.jsonb_build_object(
      -- The owning Home only for those who are in it.
      'homeId', case when private.can_see_photo_library(v_photo.owner_user_id, v_photo.owner_home_id,
        v_user_id) then v_photo.owner_home_id end,
      'albums', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', a.id, 'name', a.name)
          order by a.created_at, a.id), '[]')
        from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id
        where i.photo_id = v_photo.id
          and private.can_see_photo_album(a, v_user_id)
          and private.photo_in_album_visible(a, v_photo)));
  end
  $$;

-- The object to serve for one picture of a photo the person may see now, through its library or an
-- album share. Empty for everything else, for every reason alike.
create or replace function public.authorize_photo_read(p_photo_id uuid, p_variant text)
returns table (object_key text, content_type text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select case when p_variant = 'master' then f.object_key else v.object_key end, f.content_type
      from private.photos p
      join private.stored_files f on f.id = p.file_id and f.status = 'ready'
      left join private.photo_variants v on v.file_id = f.id and v.kind = p_variant
      where p.id = p_photo_id and p.deleted_at is null
        and p_variant in ('master', 'full', 'display', 'thumb')
        and (p_variant = 'master' or v.object_key is not null)
        and private.can_see_photo(p, v_user_id);
  end
  $$;

-- Album membership ----------------------------------------------------------------------------------------

-- Adds photos to an album (S35, extended): see can_add_photo_to_album. Photos the person may not add,
-- in the trash or already in the album are skipped without telling which. Outcomes: 'saved' (with
-- added and skipped), 'not_found', 'not_permitted', 'limit'.
create or replace function public.add_photos_to_album(p_album_id uuid, p_photo_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_ids uuid[];
    v_added integer;
  begin
    if p_album_id is null or p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_album from private.photo_albums a where a.id = p_album_id for update;
    if not found or not private.can_see_photo_album(v_album, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_contribute_to_photo_album(v_album, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    select coalesce(pg_catalog.array_agg(p.id order by p.id), '{}') into v_ids
      from private.photos p
      where p.id = any (p_photo_ids)
        and private.can_add_photo_to_album(v_album, p, v_user_id)
        and not exists (select 1 from private.photo_album_items i
          where i.album_id = v_album.id and i.photo_id = p.id);
    if (select pg_catalog.count(*) from private.photo_album_items i where i.album_id = v_album.id)
       + pg_catalog.cardinality(v_ids) > private.photo_limit('album_photos') then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into private.photo_album_items (album_id, photo_id, added_by)
      select v_album.id, u, v_user_id from pg_catalog.unnest(v_ids) u;
    get diagnostics v_added = row_count;
    perform private.audit_photo('photo_album.photos_added', v_album.owner_home_id, 'photo_album', v_album.id,
      pg_catalog.jsonb_build_object('count', v_added));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'added', v_added,
      'skipped', pg_catalog.cardinality(p_photo_ids) - v_added);
  end
  $$;

-- Takes photos out of an album ("Remove from this album"): the album's editor any photo, others the
-- photos they added or may change. The photos themselves are never deleted by this. Outcomes: 'saved'
-- (with removed), 'not_found', 'not_permitted' (nothing the person may remove was asked for).
create or replace function public.remove_photos_from_album(p_album_id uuid, p_photo_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_removed integer;
  begin
    if p_album_id is null or p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_album from private.photo_albums a where a.id = p_album_id for update;
    if not found or not private.can_see_photo_album(v_album, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    delete from private.photo_album_items i
      using private.photos p
      where i.album_id = v_album.id and i.photo_id = any (p_photo_ids) and p.id = i.photo_id
        and private.can_remove_photo_from_album(v_album, p, i.added_by, v_user_id);
    get diagnostics v_removed = row_count;
    if v_removed = 0 and not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
       v_album.created_by, v_user_id) and exists (
         select 1 from private.photo_album_items i where i.album_id = v_album.id
           and i.photo_id = any (p_photo_ids)) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    perform private.audit_photo('photo_album.photos_removed', v_album.owner_home_id, 'photo_album',
      v_album.id, pg_catalog.jsonb_build_object('count', v_removed));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'removed', v_removed);
  end
  $$;

-- Deletes an album to the trash (S35, extended): every share ends first, so restoring the album never
-- brings a share back. Its photos are untouched. Outcomes: 'deleted', 'stale', 'not_found',
-- 'not_permitted'.
create or replace function public.delete_photo_album(p_album_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_home uuid;
  begin
    if p_album_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
      v_album.created_by, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_album.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_album.revision);
    end if;
    for v_home in select s.home_id from private.photo_album_shares s where s.album_id = v_album.id
      order by s.home_id loop
      perform private.end_photo_album_share(v_album.id, v_home);
    end loop;
    update private.photo_albums a set deleted_at = pg_catalog.now(), revision = a.revision + 1
      where a.id = v_album.id;
    perform private.trash_move(v_user_id, 'photos', 'photo_album', v_album.id, v_album.owner_user_id,
      v_album.owner_home_id, v_album.name);
    perform private.audit_photo('photo_album.deleted', v_album.owner_home_id, 'photo_album', v_album.id);
    return pg_catalog.jsonb_build_object('outcome', 'deleted');
  end
  $$;

-- Sharing ---------------------------------------------------------------------------------------------------

-- Shares an album with Homes, or changes their access: p_shares is a JSON array of { homeId, access }
-- ('view' or 'contribute'), each a Home the person belongs to now and not the album's own. Only the
-- album's sharer (see can_share_photo_album). All or nothing. Lowering contribute to view keeps what
-- was added. Outcomes: 'saved' (with shareCount), 'not_found', 'not_permitted', 'limit'. 22023 for an
-- invalid list.
create function public.share_photo_album(p_album_id uuid, p_shares jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_item jsonb;
    v_homes uuid[] := '{}';
    v_home uuid;
    v_count integer;
  begin
    if p_album_id is null or p_shares is null or pg_catalog.jsonb_typeof(p_shares) <> 'array'
       or pg_catalog.jsonb_array_length(p_shares) < 1
       or pg_catalog.jsonb_array_length(p_shares) > private.photo_limit('album_shares') then
      raise exception 'invalid shares' using errcode = '22023';
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(p_shares) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'object'
         or coalesce(v_item ->> 'access', '') not in ('view', 'contribute')
         or coalesce(v_item ->> 'homeId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid shares' using errcode = '22023';
      end if;
      v_home := (v_item ->> 'homeId')::uuid;
      if v_home = any (v_homes) then
        raise exception 'invalid shares' using errcode = '22023';
      end if;
      v_homes := v_homes || v_home;
    end loop;

    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_share_photo_album(v_album, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    -- Every destination: a Home the person is in now, never the album's own.
    if exists (select 1 from pg_catalog.unnest(v_homes) h
        where h is not distinct from v_album.owner_home_id
          or private.photo_access(h, v_user_id) is null) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    select pg_catalog.count(*) into v_count from (
      select s.home_id from private.photo_album_shares s where s.album_id = v_album.id
      union select h from pg_catalog.unnest(v_homes) h) x;
    if v_count > private.photo_limit('album_shares') then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;

    insert into private.photo_album_shares (album_id, home_id, access, shared_by)
      select v_album.id, (e ->> 'homeId')::uuid, e ->> 'access', v_user_id
      from pg_catalog.jsonb_array_elements(p_shares) e
      on conflict (album_id, home_id) do update
        set access = excluded.access, updated_at = pg_catalog.now()
        where private.photo_album_shares.access is distinct from excluded.access;
    perform private.audit_photo('photo_album.shared', v_album.owner_home_id, 'photo_album', v_album.id,
      pg_catalog.jsonb_build_object('homes', pg_catalog.cardinality(v_homes)));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'shareCount', v_count);
  end
  $$;

-- Ends an album's share with one Home ("Remove from this Home"): by the album's sharer, or by that
-- Home's photo managers. Only the share and the memberships it allowed go; no photo of any library is
-- deleted. Outcomes: 'removed', 'not_found', 'not_permitted'.
create function public.unshare_photo_album(p_album_id uuid, p_home_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
  begin
    if p_album_id is null or p_home_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_album from private.photo_albums a where a.id = p_album_id for update;
    if not found or not private.can_see_photo_album(v_album, v_user_id)
       or not exists (select 1 from private.photo_album_shares s
         where s.album_id = v_album.id and s.home_id = p_home_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not (private.can_share_photo_album(v_album, v_user_id)
        or coalesce(private.photo_access(p_home_id, v_user_id) = 'manage', false)) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    perform private.end_photo_album_share(v_album.id, p_home_id);
    perform private.audit_photo('photo_album.unshared', v_album.owner_home_id, 'photo_album', v_album.id,
      pg_catalog.jsonb_build_object('homeId', p_home_id));
    return pg_catalog.jsonb_build_object('outcome', 'removed');
  end
  $$;

-- Library deletion impact --------------------------------------------------------------------------------

-- What deleting these photos from their library would affect, for the confirmation: how many the
-- person may delete, their libraries, the albums the person can see that show them, the Homes the
-- person belongs to that see them through a share, and whether albums or Homes the person cannot see
-- are affected too (a flag, never a name or a count). Changes nothing.
create function public.photo_deletion_impact(p_photo_ids uuid[]) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_ids uuid[];
  begin
    if p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select coalesce(pg_catalog.array_agg(p.id), '{}') into v_ids
      from private.photos p
      where p.id = any (p_photo_ids) and p.deleted_at is null
        and private.can_see_photo_library(p.owner_user_id, p.owner_home_id, v_user_id)
        and private.can_change_photo_item(p.owner_user_id, p.owner_home_id, p.created_by, v_user_id);
    return pg_catalog.jsonb_build_object(
      'deletable', pg_catalog.cardinality(v_ids),
      'skipped', (select pg_catalog.count(distinct u) from pg_catalog.unnest(p_photo_ids) u) - pg_catalog.cardinality(v_ids),
      'libraries', (
        select coalesce(pg_catalog.jsonb_agg(x.lib order by x.lib ->> 'homeName' nulls first), '[]') from (
          select distinct pg_catalog.jsonb_build_object('personal', p.owner_user_id is not null,
            'homeName', private.photo_home_name(p.owner_home_id)) as lib
          from private.photos p where p.id = any (v_ids)) x),
      'albums', (
        select coalesce(pg_catalog.jsonb_agg(distinct a.name), '[]')
        from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id
        join private.photos p on p.id = i.photo_id
        where i.photo_id = any (v_ids) and private.can_see_photo_album(a, v_user_id)
          and private.photo_in_album_visible(a, p)),
      'otherAlbums', exists (
        select 1 from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
        where i.photo_id = any (v_ids) and not private.can_see_photo_album(a, v_user_id)),
      -- Homes that lose the photos: those an album shows them to through a share, and the Home
      -- that owns an album of another library the photos were added to. Named when the person is in
      -- them; otherwise only flagged (as is another person's personal album).
      'sharedHomes', (
        select coalesce(pg_catalog.jsonb_agg(distinct h.name), '[]')
        from (
          select s.home_id
            from private.photo_album_items i
            join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
            join private.photos p on p.id = i.photo_id
            join private.photo_album_shares s on s.album_id = a.id
            where i.photo_id = any (v_ids) and private.photo_in_album_visible(a, p)
          union
          select a.owner_home_id
            from private.photo_album_items i
            join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
            join private.photos p on p.id = i.photo_id
            where i.photo_id = any (v_ids) and a.owner_home_id is distinct from p.owner_home_id
              and private.photo_in_album_visible(a, p)
        ) x
        join public.homes h on h.id = x.home_id
        where private.photo_access(x.home_id, v_user_id) is not null),
      'otherHomes', exists (
        select 1 from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
        join private.photos p on p.id = i.photo_id
        join private.photo_album_shares s on s.album_id = a.id
        where i.photo_id = any (v_ids) and private.photo_in_album_visible(a, p)
          and private.photo_access(s.home_id, v_user_id) is null)
      or exists (
        select 1 from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
        join private.photos p on p.id = i.photo_id
        where i.photo_id = any (v_ids) and private.photo_in_album_visible(a, p)
          and ((a.owner_user_id is not null and a.owner_user_id is distinct from v_user_id)
            or (a.owner_home_id is not null and a.owner_home_id is distinct from p.owner_home_id
              and private.photo_access(a.owner_home_id, v_user_id) is null))));
  end
  $$;

-- Photo widget --------------------------------------------------------------------------------------------

-- The photos a photo widget shows to this viewer now, in the widget's context (p_home_id: a Home's
-- dashboard or a Home-bound widget; null: the personal dashboard). Exactly one source: an album
-- (the library's own or, for a Home, one shared with it; its newest 100 photos that still belong
-- there) or hand-picked photos (kept in the chosen order; personal: the viewer's own photos; Home: the
-- Home's photos or photos in its albums and albums shared with it). Never a substitute: 'available'
-- false for an album the viewer cannot use here, 'missing' counts picked photos that cannot be shown.
-- Null for a Home the viewer is not in. 22023 for an invalid source.
create function public.resolve_photo_widget(p_home_id uuid, p_album_id uuid, p_photo_ids uuid[])
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_photos jsonb;
    v_count integer;
  begin
    if (p_album_id is null) = (p_photo_ids is null)
       or (p_photo_ids is not null and (pg_catalog.cardinality(p_photo_ids) < 1
         or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('widget_photos'))) then
      raise exception 'invalid source' using errcode = '22023';
    end if;
    if p_home_id is not null and private.photo_access(p_home_id, v_user_id) is null then
      return null;
    end if;

    if p_album_id is not null then
      select * into v_album from private.photo_albums a where a.id = p_album_id;
      if not found or not private.photo_album_in_context(v_album, p_home_id, v_user_id)
         or not private.can_see_photo_album(v_album, v_user_id) then
        return pg_catalog.jsonb_build_object('available', false, 'photos', '[]'::jsonb, 'missing', 0);
      end if;
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', x.id, 'width', x.width, 'height', x.height) order by x.added_at desc, x.id), '[]')
        into v_photos
        from (
          select p.id, p.width, p.height, i.added_at from private.photo_album_items i
            join private.photos p on p.id = i.photo_id
            where i.album_id = v_album.id and private.photo_in_album_visible(v_album, p)
            order by i.added_at desc, p.id
            limit private.photo_limit('widget_album')
        ) x;
      return pg_catalog.jsonb_build_object('available', true, 'photos', v_photos, 'missing', 0);
    end if;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'width', p.width, 'height', p.height) order by x.position), '[]'),
      pg_catalog.count(p.id)
      into v_photos, v_count
      from (select u.id, pg_catalog.min(u.position) as position
            from pg_catalog.unnest(p_photo_ids) with ordinality as u(id, position) group by u.id) x
      join private.photos p on p.id = x.id
      where private.can_see_photo(p, v_user_id)
        and case
          when p_home_id is null then coalesce(p.owner_user_id = v_user_id, false)
          else coalesce(p.owner_home_id = p_home_id, false) or exists (
            select 1 from private.photo_album_items i
            join private.photo_albums a on a.id = i.album_id
            where i.photo_id = p.id
              and private.photo_album_in_context(a, p_home_id, v_user_id)
              and private.photo_in_album_visible(a, p))
        end;
    return pg_catalog.jsonb_build_object('available', true, 'photos', v_photos,
      'missing', (select pg_catalog.count(distinct u) from pg_catalog.unnest(p_photo_ids) u) - v_count);
  end
  $$;

-- Home exit ---------------------------------------------------------------------------------------------

-- When someone leaves a Home (or is removed), the shares of their personal albums with that Home
-- end: the Home no longer sees their personal photos, and they no longer see what that Home added.
-- Their own photos stay theirs and the Home's stay the Home's; nothing is deleted.
create function private.end_photo_shares_on_exit() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_album uuid;
  begin
    for v_album in
      select s.album_id from private.photo_album_shares s
        join private.photo_albums a on a.id = s.album_id
        where s.home_id = old.home_id and a.owner_user_id = old.user_id
        order by s.album_id
    loop
      perform private.end_photo_album_share(v_album, old.home_id);
    end loop;
    return old;
  end
  $$;

create trigger home_memberships_end_photo_shares
  after delete on public.home_memberships
  for each row execute function private.end_photo_shares_on_exit();

-- Grants --------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'share_photo_album', 'unshare_photo_album', 'photo_deletion_impact', 'resolve_photo_widget'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like '%photo%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
