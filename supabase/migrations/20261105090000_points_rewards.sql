-- S23: points and rewards (brief plans/steps/S23-brief.md; ADR 0030; spec "Confirmed uniform base
-- chore points across eligible members", "Confirmed per-occurrence chore reward value
-- preservation", "Confirmed reward timing for delayed chore approvals", "Confirmed late completion
-- rewards for overdue chores", "Confirmed correction and reversal of completed chores", "Confirmed
-- reward balance privacy and optional Home leaderboard", "Confirmed manual reward point bonuses and
-- adjustments", "Confirmed Home reward points on membership departure", "Confirmed reward points
-- never expire", "Confirmed optional approval for reward redemption", "Confirmed independent reviewer
-- for reward redemptions", "Confirmed cancellation of pending reward redemptions", "Confirmed reward
-- availability and redemption limits", "Confirmed reward fulfillment tracking", "Confirmed
-- unable-to-fulfill reward resolution", "Confirmed individual Home leaderboard opt-out", "Confirmed
-- Home leaderboard tie-breaking", "Confirmed Home leaderboard ranking periods", "Confirmed optional
-- personal weekly chore point targets", "Confirmed optional shared Home weekly chore points
-- overview", "Confirmed optional Ora-led chore points notifications"). Builds on the chore
-- migrations; like them, nothing is exposed as a table.
--
-- Chore points. Each chore has one base value (0-1000) and a late policy (full, reduced to a fixed
-- amount, or zero). Every occurrence snapshots them when it is created (a trigger, so every path
-- that creates occurrences is covered); a later change to the chore applies to occurrences created
-- after it. A completion is late when the Home-local date of its reported completion time is after
-- the occurrence's due date; the review time never counts.
--
-- The ledger. private.point_entries is append-only: one row per change to one member's Home
-- account (private.point_accounts, one per Home and account, kept when the membership ends, so
-- rejoining restores it and another Home never sees it). An account caches its balance (the sum of
-- its entries) and its reserved points (the sum of its pending approval-required requests);
-- available = balance - reserved. Earned points are chore awards, chore reversals, bonuses,
-- corrections and reversals of manual entries; spent points are redemptions less refunds.
--
-- Chore awards are reconciled, never edited: after any change to an occurrence's state, contributor,
-- completion time, deletion, due date or points snapshot, private.reconcile_chore_points computes the
-- award the occurrence should carry and, when it differs from the one it carries, posts a reversal of
-- the old one and the new award. Retries, replays and concurrent approvals therefore never pay twice.
--
-- Balances never become spendable below zero through a manual debit or a redemption
-- ('insufficient_points', nothing partial). A chore reversal is posted in full so the ledger stays
-- true; it never touches reserved points or fulfilled rewards, and an account it leaves below zero
-- shows as owed until later points or a manager's correction cover it.
--
-- Rewards and redemptions. A reward is immediate (the default) or approval-required. Redeeming or
-- requesting checks membership, the enabled state, the availability window, total and per-member
-- capacity (pending and redeemed count) and available points atomically, under the reward's lock and
-- then the account's. A pending request reserves its cost and its capacity; approval (a different
-- current member with approveHomeRewards: never the requester) turns the reservation into one
-- redemption entry; rejection or cancellation releases it once. Fulfillment (Pending, Fulfilled,
-- Unable to fulfill) is tracked apart; Unable to fulfill is resolved explicitly by a refund (one
-- linked entry) or a replacement (never charged again). Leaving or being removed cancels pending
-- requests and releases their reservations once.
--
-- Who may do what (defaults picked in the brief): every current member sees their own balance and
-- ledger, the enabled catalog, redeems and requests, cancels their own pending request, sees the
-- leaderboard when it is on and sets their own participation and weekly target. Three delegable
-- capabilities (Owner always): manageHomeRewards (catalog, limits, leaderboard settings, fulfillment
-- and resolutions, cancelling someone else's request), approveHomeRewards (approving or rejecting
-- someone else's request), manageHomePoints (every member's balance and ledger, bonuses, corrections,
-- reversals, and together with manageHomeChores any correction or reopen that changes awarded points).
--
-- Lock order: rewards and manual adjustments take the Home row first (private.lock_points_home), then
-- reward -> redemption -> account, like leaving and removal. Chore paths keep the chore modules'
-- order (chore -> occurrence) and take the Home row and the account afterwards (ADR 0030).

-- Capabilities, audit subjects, events, notification categories ----------------------------------------

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints'
  );
  $$;

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings'
  ));

alter table private.chore_occurrence_events drop constraint chore_occurrence_events_kind_check;
alter table private.chore_occurrence_events add constraint chore_occurrence_events_kind_check
  check (kind in ('completed', 'skipped', 'reopened', 'submitted', 'approved', 'rejected',
    'withdrawn', 'corrected', 'claimed', 'released', 'expired', 'reassigned', 'volunteered',
    'assignment_corrected', 'vacation_paused', 'vacation_resumed', 'vacation_substituted',
    'vacation_restored', 'points_corrected'));

-- A 'points_corrected' event: the snapshot points after and before.
alter table private.chore_occurrence_events
  add column points integer,
  add column previous_points integer;

-- 'points' (chore points awarded or reversed): optional and opt-in, so in-app is off until the
-- person turns it on. 'rewards' (requests, decisions, fulfillment, manual adjustments): optional,
-- in-app on, email opt-in.
create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true
    when 'invitations' then false when 'reminders' then false when 'approvals' then false
    when 'chores' then false when 'points' then false when 'rewards' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage', 'reminders', 'approvals', 'chores',
    'points', 'rewards'));

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check
  check (category in ('invitations', 'reminders', 'approvals', 'chores', 'points', 'rewards'));

-- packages/domain optionalNotificationCategories lists the same.
create or replace function private.notification_category_optional(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_category in ('invitations', 'reminders', 'approvals', 'chores', 'points', 'rewards'),
    false);
  $$;

-- The built-in default: in-app on, email off, except 'points', which is opt-in on every channel.
create or replace function private.effective_notification_channel(
  p_user_id uuid, p_home_id uuid, p_category text, p_channel text
) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_value boolean;
  begin
    if private.notification_category_essential(p_category) then
      return true;
    end if;
    if p_home_id is not null then
      select p.enabled into v_value from public.notification_preferences p
        where p.user_id = p_user_id and p.home_id = p_home_id
          and p.category = p_category and p.channel = p_channel;
      if found then
        return v_value;
      end if;
    end if;
    select p.enabled into v_value from public.notification_preferences p
      where p.user_id = p_user_id and p.home_id is null
        and p.category = p_category and p.channel = p_channel;
    if found then
      return v_value;
    end if;
    return p_channel = 'in_app' and p_category <> 'points';
  end
  $$;

create or replace function public.get_notification_settings()
returns table (home_id uuid, category text, channel text, enabled boolean, overridden boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select s.home_id, c.category, ch.channel,
        private.effective_notification_channel(v_user_id, s.home_id, c.category, ch.channel),
        exists (
          select 1 from public.notification_preferences p
          where p.user_id = v_user_id and p.home_id is not distinct from s.home_id
            and p.category = c.category and p.channel = ch.channel
        )
      from (
        select null::uuid as home_id
        union all
        select m.home_id from public.home_memberships m where m.user_id = v_user_id
      ) s
      cross join (values ('invitations'), ('reminders'), ('approvals'), ('chores'), ('points'),
        ('rewards')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

-- Limits (apps/web/src/points/schema.ts uses the same numbers).
create function private.points_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'chore_points' then 1000      -- base points of one chore
    when 'adjustment' then 100000      -- largest manual bonus or correction
    when 'cost' then 100000            -- largest reward cost
    when 'reason' then 300             -- adjustment, cancellation, rejection and fulfillment notes
    when 'reason_min' then 3           -- a meaningful reason
    when 'reward_name' then 80
    when 'reward_description' then 500
    when 'replacement' then 200
    when 'total_limit' then 10000
    when 'member_limit' then 100
    when 'rewards' then 200            -- active (not archived) rewards per Home
    when 'target' then 100000          -- largest weekly target
    when 'page' then 50                -- ledger entries one read returns
    when 'redemptions_page' then 100
  end;
  $$;

-- Chore points ------------------------------------------------------------------------------------------

alter table private.chores
  add column points integer not null default 0,
  add column late_policy text not null default 'full',
  add column late_points integer;
alter table private.chores
  add constraint chores_points_check check (points between 0 and 1000),
  add constraint chores_late_policy_check check (
    late_policy in ('full', 'reduced', 'zero')
    and (late_policy = 'reduced') = (late_points is not null)
    and (late_points is null or late_points between 0 and points));

-- The snapshot each occurrence keeps from its creation (spec: never the series' current value).
alter table private.chore_occurrences
  add column points integer not null default 0,
  add column late_policy text not null default 'full',
  add column late_points integer;
alter table private.chore_occurrences
  add constraint chore_occurrences_points_check check (points between 0 and 1000),
  add constraint chore_occurrences_late_policy_check check (
    late_policy in ('full', 'reduced', 'zero')
    and (late_policy = 'reduced') = (late_points is not null)
    and (late_points is null or late_points between 0 and points));

-- Suggested points of a template (copied into the new-chore form like its other fields).
alter table private.chore_templates
  add column points integer not null default 0,
  add column late_policy text not null default 'full',
  add column late_points integer;
alter table private.chore_templates
  add constraint chore_templates_points_check check (points between 0 and 1000),
  add constraint chore_templates_late_policy_check check (
    late_policy in ('full', 'reduced', 'zero')
    and (late_policy = 'reduced') = (late_points is not null)
    and (late_points is null or late_points between 0 and points));

create function private.snapshot_chore_points() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    select c.points, c.late_policy, c.late_points into new.points, new.late_policy, new.late_points
      from private.chores c where c.id = new.chore_id;
    return new;
  end
  $$;

create trigger chore_occurrences_snapshot_points before insert on private.chore_occurrences
  for each row execute function private.snapshot_chore_points();

-- Whether a points setting is valid: points 0-1000; a reduced policy names an amount up to points.
create function private.valid_chore_points(p_points integer, p_policy text, p_late_points integer)
returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_points between 0 and private.points_limit('chore_points')
    and p_policy in ('full', 'reduced', 'zero')
    and (p_policy = 'reduced') = (p_late_points is not null)
    and (p_late_points is null or p_late_points between 0 and p_points), false);
  $$;

-- The points a completion earns: the snapshot when on time; when late, the policy's amount.
create function private.chore_award(p_points integer, p_policy text, p_late_points integer, p_late boolean)
returns integer
  language sql immutable set search_path = '' as $$
  select case
    when not coalesce(p_late, false) or p_policy = 'full' then p_points
    when p_policy = 'reduced' then least(coalesce(p_late_points, 0), p_points)
    else 0
  end;
  $$;

-- Whether a completion at p_at is late for an occurrence due on p_due in the Home's timezone.
create function private.chore_late(p_home_id uuid, p_due date, p_at timestamptz) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_at is not null and (p_at at time zone private.home_zone(p_home_id))::date > p_due;
  $$;

-- Tables ---------------------------------------------------------------------------------------------------

-- One member's points in one Home. Kept when the membership ends (spec: preserved, restored on
-- rejoining with the same account); user_id becomes null only when the account itself is deleted.
create table private.point_accounts (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  -- The sum of the account's entries.
  balance integer not null default 0,
  -- The sum of its pending approval-required requests.
  reserved integer not null default 0 constraint point_accounts_reserved_check check (reserved >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint point_accounts_home_user_key unique (home_id, user_id),
  constraint point_accounts_id_home_key unique (id, home_id)
);

create table private.rewards (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null constraint rewards_name_check check (private.is_visible_name(name, 80)),
  description text constraint rewards_description_check
    check (description is null or private.is_plain_text(description, 500)),
  cost integer not null constraint rewards_cost_check check (cost between 1 and 100000),
  requires_approval boolean not null default false,
  enabled boolean not null default true,
  -- Inclusive first and last day it can be redeemed, in the Home's timezone (null: open-ended).
  available_from date,
  available_until date,
  -- At most this many pending and redeemed requests in total (null: unlimited).
  total_limit integer constraint rewards_total_limit_check check (total_limit between 1 and 10000),
  -- At most member_limit pending and redeemed requests per member per period.
  member_limit integer constraint rewards_member_limit_check check (member_limit between 1 and 100),
  member_period text constraint rewards_member_period_check
    check (member_period in ('week', 'month', 'year', 'ever')),
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint rewards_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint rewards_id_home_key unique (id, home_id),
  constraint rewards_window_check check (
    available_from is null or available_until is null or available_until >= available_from),
  constraint rewards_member_check check ((member_limit is null) = (member_period is null))
);

create index rewards_home_idx on private.rewards (home_id) where archived_at is null;

-- One redemption or request. Never deleted; its events are append-only.
create table private.reward_redemptions (
  id uuid primary key,
  seq bigint generated always as identity,
  home_id uuid not null,
  reward_id uuid not null,
  account_id uuid not null,
  requested_by uuid references auth.users (id) on delete set null,
  -- What it cost and was called when requested (a later edit never changes it).
  cost integer not null constraint reward_redemptions_cost_check check (cost between 1 and 100000),
  reward_name text not null,
  status text not null constraint reward_redemptions_status_check
    check (status in ('pending', 'redeemed', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  -- A rejection's optional reason, or a manager's cancellation reason ('departed' never shows here).
  decision_reason text,
  -- Cancelled because the requester left the Home.
  departed boolean not null default false,
  redeemed_at timestamptz,
  fulfillment text constraint reward_redemptions_fulfillment_check
    check (fulfillment in ('pending', 'fulfilled', 'unable')),
  fulfillment_at timestamptz,
  fulfillment_by uuid references auth.users (id) on delete set null,
  fulfillment_note text,
  -- How an Unable-to-fulfill reward was resolved.
  resolution text constraint reward_redemptions_resolution_check
    check (resolution in ('refund', 'replacement')),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolution_note text,
  replacement text,
  replacement_responsible uuid references auth.users (id) on delete set null,
  replacement_status text constraint reward_redemptions_replacement_status_check
    check (replacement_status in ('pending', 'fulfilled', 'unable')),
  revision integer not null default 1 constraint reward_redemptions_revision_check check (revision >= 1),
  foreign key (reward_id, home_id) references private.rewards (id, home_id) on delete cascade,
  foreign key (account_id, home_id) references private.point_accounts (id, home_id) on delete cascade,
  constraint reward_redemptions_state_check check (
    (status = 'redeemed') = (redeemed_at is not null)
    and (status = 'redeemed') = (fulfillment is not null)
    and (status = 'pending') = (decided_at is null)
    and (resolution is null or fulfillment = 'unable')
    and (resolution = 'replacement') = (replacement is not null)
    and (resolution = 'replacement') = (replacement_status is not null))
);

create index reward_redemptions_reward_idx on private.reward_redemptions (reward_id, status);
create index reward_redemptions_account_idx on private.reward_redemptions (account_id, requested_at desc);
create index reward_redemptions_home_pending_idx on private.reward_redemptions (home_id, seq)
  where status = 'pending';
create index reward_redemptions_home_fulfillment_idx on private.reward_redemptions (home_id, seq)
  where status = 'redeemed';

create table private.point_entries (
  id uuid primary key,
  -- Order of posting across every Home.
  seq bigint generated always as identity,
  home_id uuid not null,
  account_id uuid not null,
  kind text not null constraint point_entries_kind_check check (kind in (
    'chore_award', 'chore_reversal', 'bonus', 'correction', 'manual_reversal', 'redemption', 'refund')),
  amount integer not null constraint point_entries_amount_check check (amount <> 0),
  -- When the points count for periods: the completion time for chore entries (the original's for a
  -- reversal), otherwise the posting time.
  attributed_at timestamptz not null,
  occurrence_id uuid references private.chore_occurrences (id) on delete set null,
  redemption_id uuid references private.reward_redemptions (id) on delete set null,
  reverses_id uuid references private.point_entries (id) on delete set null,
  -- A chore award: whether the completion was late.
  late boolean,
  reason text,
  actor_id uuid references auth.users (id) on delete set null,
  available_before integer not null,
  available_after integer not null,
  reserved_after integer not null,
  created_at timestamptz not null default now(),
  foreign key (account_id, home_id) references private.point_accounts (id, home_id) on delete cascade,
  constraint point_entries_sign_check check (
    (kind in ('chore_award', 'bonus', 'refund') and amount > 0)
    or (kind in ('chore_reversal', 'redemption') and amount < 0)
    or kind in ('correction', 'manual_reversal')),
  constraint point_entries_links_check check (
    (kind = 'chore_award') = (late is not null)
    and (kind in ('chore_reversal', 'manual_reversal')) = (reverses_id is not null)
    and (kind in ('redemption', 'refund')) = (redemption_id is not null))
);

create index point_entries_account_idx on private.point_entries (account_id, seq desc);
create index point_entries_home_attributed_idx on private.point_entries (home_id, attributed_at);
create index point_entries_occurrence_idx on private.point_entries (occurrence_id)
  where occurrence_id is not null;
-- An entry is reversed at most once; a redemption is charged and refunded at most once.
create unique index point_entries_one_reversal on private.point_entries (reverses_id)
  where reverses_id is not null;
create unique index point_entries_one_redemption on private.point_entries (redemption_id)
  where kind = 'redemption';
create unique index point_entries_one_refund on private.point_entries (redemption_id)
  where kind = 'refund';

create table private.reward_redemption_events (
  id bigint generated always as identity primary key,
  redemption_id uuid not null references private.reward_redemptions (id) on delete cascade,
  kind text not null constraint reward_redemption_events_kind_check check (kind in (
    'requested', 'redeemed', 'approved', 'rejected', 'cancelled', 'fulfilled', 'unable',
    'fulfillment_corrected', 'refunded', 'replacement', 'replacement_fulfilled',
    'replacement_unable')),
  actor_id uuid references auth.users (id) on delete set null,
  note text,
  -- fulfillment_corrected: the state before and after; cancelled: whether the requester left.
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index reward_redemption_events_redemption_idx on private.reward_redemption_events (redemption_id, id);

-- A member's own choices in one Home, kept when the membership ends (spec: the opt-out survives
-- ordinary membership changes).
create table private.point_preferences (
  home_id uuid not null references public.homes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Appears on the leaderboard and in the shared weekly overview.
  participates boolean not null default true,
  -- Weekly chore-point target; null or 0: none.
  target integer constraint point_preferences_target_check check (target between 0 and 100000),
  target_paused boolean not null default false,
  -- Others see the target in the shared weekly overview.
  share_target boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (home_id, user_id)
);

-- The Home's leaderboard (rewards managers).
create table private.point_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  leaderboard_enabled boolean not null default false,
  default_period text not null default 'month'
    constraint point_settings_period_check check (default_period in ('week', 'month', 'all')),
  revision integer not null default 1 constraint point_settings_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table private.point_accounts enable row level security;
alter table private.rewards enable row level security;
alter table private.reward_redemptions enable row level security;
alter table private.point_entries enable row level security;
alter table private.reward_redemption_events enable row level security;
alter table private.point_preferences enable row level security;
alter table private.point_settings enable row level security;

revoke all on private.point_accounts, private.rewards, private.reward_redemptions,
  private.point_entries, private.reward_redemption_events, private.point_preferences,
  private.point_settings from public, anon, authenticated;

-- Permissions -----------------------------------------------------------------------------------------------

create function private.can_manage_rewards(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and private.has_home_capability(p_home_id, p_user_id, 'manageHomeRewards');
  $$;

create function private.can_approve_rewards(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and private.has_home_capability(p_home_id, p_user_id, 'approveHomeRewards');
  $$;

create function private.can_manage_points(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and private.has_home_capability(p_home_id, p_user_id, 'manageHomePoints');
  $$;

-- Whether p_user may read an account: its own holder while a member, or a points manager.
create function private.can_view_point_account(p_account private.point_accounts, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_account.id is not null and (
    (p_account.user_id = p_user_id and private.is_home_member(p_account.home_id, p_user_id))
    or private.can_manage_points(p_account.home_id, p_user_id));
  $$;

-- Ledger primitives ---------------------------------------------------------------------------------------

-- Takes the Home row's key-share lock first. Leaving and removal lock the Home row for update and
-- then rewards, redemptions and accounts, and every ledger write takes a key-share lock on the Home
-- row (its foreign key). Taking it before any other lock keeps one order (Home first) everywhere, so
-- a change racing a departure waits instead of deadlocking.
create function private.lock_points_home(p_home_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    perform 1 from public.homes h where h.id = p_home_id for key share;
  end
  $$;

-- The account of p_user in p_home, created when missing, locked.
create function private.lock_point_account(p_home_id uuid, p_user_id uuid) returns private.point_accounts
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_account private.point_accounts;
  begin
    perform private.lock_points_home(p_home_id);
    insert into private.point_accounts (home_id, user_id) values (p_home_id, p_user_id)
      on conflict (home_id, user_id) do nothing;
    select * into v_account from private.point_accounts a
      where a.home_id = p_home_id and a.user_id = p_user_id for update;
    return v_account;
  end
  $$;

-- Posts one entry to a locked account and moves its balance. Records available points before and
-- after and the reserved points after.
create function private.post_point_entry(
  p_account_id uuid, p_kind text, p_amount integer, p_attributed_at timestamptz,
  p_occurrence_id uuid, p_redemption_id uuid, p_reverses_id uuid, p_reason text, p_actor uuid,
  p_late boolean, p_id uuid default null
) returns private.point_entries
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_account private.point_accounts;
    v_entry private.point_entries;
  begin
    update private.point_accounts a set balance = a.balance + p_amount, updated_at = pg_catalog.now()
      where a.id = p_account_id
      returning * into v_account;
    insert into private.point_entries (
      id, home_id, account_id, kind, amount, attributed_at, occurrence_id, redemption_id, reverses_id,
      late, reason, actor_id, available_before, available_after, reserved_after
    ) values (
      coalesce(p_id, gen_random_uuid()), v_account.home_id, v_account.id, p_kind, p_amount,
      coalesce(p_attributed_at, pg_catalog.now()), p_occurrence_id, p_redemption_id, p_reverses_id,
      p_late, p_reason, p_actor, v_account.balance - p_amount - v_account.reserved,
      v_account.balance - v_account.reserved, v_account.reserved
    ) returning * into v_entry;
    return v_entry;
  end
  $$;

-- Moves a locked account's reserved points.
create function private.change_reserved(p_account_id uuid, p_delta integer) returns void
  language sql volatile security definer set search_path = '' as $$
  update private.point_accounts a set reserved = a.reserved + p_delta, updated_at = pg_catalog.now()
    where a.id = p_account_id;
  $$;

-- Tells the account holder about a chore award or reversal (category 'points', opt-in). One notice
-- per entry, so retries never repeat it. Ids and numbers only.
create function private.notify_chore_points(p_entry private.point_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user uuid;
  begin
    select a.user_id into v_user from private.point_accounts a where a.id = p_entry.account_id;
    if v_user is null then
      return;
    end if;
    perform private.notify_user(v_user, p_entry.home_id, 'points',
      case p_entry.kind when 'chore_award' then 'points.awarded' else 'points.reversed' end,
      pg_catalog.jsonb_build_object('homeId', p_entry.home_id, 'occurrenceId', p_entry.occurrence_id,
        'amount', abs(p_entry.amount), 'available', p_entry.available_after,
        'late', coalesce(p_entry.late, false)),
      'points:' || p_entry.id::text, true);
  end
  $$;

-- Tells the account holder about a manual adjustment or its reversal (category 'rewards').
create function private.notify_point_adjustment(p_entry private.point_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user uuid;
  begin
    select a.user_id into v_user from private.point_accounts a where a.id = p_entry.account_id;
    if v_user is null then
      return;
    end if;
    perform private.notify_user(v_user, p_entry.home_id, 'rewards',
      case p_entry.kind when 'bonus' then 'points.bonus' when 'correction' then 'points.corrected'
        else 'points.adjustment_reversed' end,
      pg_catalog.jsonb_build_object('homeId', p_entry.home_id, 'amount', p_entry.amount,
        'available', p_entry.available_after),
      'points:' || p_entry.id::text, true);
  end
  $$;

-- The live (not reversed) award an occurrence carries, if any.
create function private.live_chore_award(p_occurrence_id uuid) returns private.point_entries
  language sql stable security definer set search_path = '' as $$
  select e.* from private.point_entries e
  where e.occurrence_id = p_occurrence_id and e.kind = 'chore_award'
    and not exists (select 1 from private.point_entries r where r.reverses_id = e.id)
  order by e.seq desc limit 1;
  $$;

-- The award an occurrence in this state should carry: (contributor, amount, late), amount 0 for none.
create function private.desired_chore_award(p_occurrence private.chore_occurrences)
returns table (user_id uuid, amount integer, late boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_late boolean;
  begin
    if p_occurrence.status <> 'completed' or p_occurrence.deleted_at is not null
       or p_occurrence.contributor_id is null then
      return query select null::uuid, 0, false;
      return;
    end if;
    v_late := private.chore_late(p_occurrence.home_id, p_occurrence.due_date, p_occurrence.completed_at);
    return query select p_occurrence.contributor_id,
      private.chore_award(p_occurrence.points, p_occurrence.late_policy, p_occurrence.late_points, v_late),
      v_late;
  end
  $$;

-- Brings an occurrence's award in line with its state (see the header). Callers hold its chore's
-- lock or its row (every change to an occurrence does), so two reconciliations of one occurrence
-- never run at once.
create function private.reconcile_chore_points(p_occurrence private.chore_occurrences) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_live private.point_entries;
    v_live_user uuid;
    v_want record;
    v_account private.point_accounts;
    v_entry private.point_entries;
    v_actor uuid := auth.uid();
  begin
    select * into v_want from private.desired_chore_award(p_occurrence);
    v_live := private.live_chore_award(p_occurrence.id);
    if v_live.id is not null then
      select a.user_id into v_live_user from private.point_accounts a where a.id = v_live.account_id;
      if v_want.amount > 0 and v_live_user = v_want.user_id and v_live.amount = v_want.amount
         and v_live.attributed_at = p_occurrence.completed_at and v_live.late = v_want.late then
        return;
      end if;
      perform 1 from private.point_accounts a where a.id = v_live.account_id for update;
      v_entry := private.post_point_entry(v_live.account_id, 'chore_reversal', -v_live.amount,
        v_live.attributed_at, p_occurrence.id, null, v_live.id, null, v_actor, null);
      perform private.notify_chore_points(v_entry);
    end if;
    if v_want.amount > 0 then
      v_account := private.lock_point_account(p_occurrence.home_id, v_want.user_id);
      v_entry := private.post_point_entry(v_account.id, 'chore_award', v_want.amount,
        p_occurrence.completed_at, p_occurrence.id, null, null, null, v_actor, v_want.late);
      perform private.notify_chore_points(v_entry);
    end if;
  end
  $$;

create function private.chore_occurrence_points_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    -- Deleting the contributor's account clears the contributor: the ledger keeps what was earned.
    if new.contributor_id is null and old.contributor_id is not null and new.status = old.status
       and new.completed_at is not distinct from old.completed_at
       and new.deleted_at is not distinct from old.deleted_at then
      return new;
    end if;
    perform private.reconcile_chore_points(new);
    return new;
  end
  $$;

create trigger chore_occurrences_points after update on private.chore_occurrences
  for each row when (
    old.status is distinct from new.status or old.contributor_id is distinct from new.contributor_id
    or old.completed_at is distinct from new.completed_at or old.deleted_at is distinct from new.deleted_at
    or old.due_date is distinct from new.due_date or old.points is distinct from new.points
    or old.late_policy is distinct from new.late_policy or old.late_points is distinct from new.late_points)
  execute function private.chore_occurrence_points_changed();

-- Chore functions with points ---------------------------------------------------------------------------

-- Creating a chore takes its points (chore managers already create chores; spec: points are edited by
-- authorized chore managers). The chore and its first occurrences are new, so they take the values.
alter function public.create_chore(uuid, uuid, text, jsonb, jsonb, text, uuid, integer, date, text,
  integer, date, smallint[], date, integer, boolean) set schema private;
alter function private.create_chore(uuid, uuid, text, jsonb, jsonb, text, uuid, integer, date, text,
  integer, date, smallint[], date, integer, boolean) rename to create_chore_before_points;

create function public.create_chore(
  p_id uuid, p_home_id uuid, p_title text, p_assignment jsonb, p_steps jsonb default '[]'::jsonb,
  p_instructions text default null, p_category_id uuid default null, p_minutes integer default null,
  p_due_date date default null,
  p_frequency text default null, p_interval integer default null, p_starts_on date default null,
  p_weekdays smallint[] default null, p_ends_on date default null, p_max_count integer default null,
  p_requires_approval boolean default false,
  p_points integer default 0, p_late_policy text default 'full', p_late_points integer default null
) returns table (outcome text, occurrence_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
  begin
    if not private.valid_chore_points(p_points, p_late_policy, p_late_points) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_row from private.create_chore_before_points(p_id, p_home_id, p_title, p_assignment,
      p_steps, p_instructions, p_category_id, p_minutes, p_due_date, p_frequency, p_interval,
      p_starts_on, p_weekdays, p_ends_on, p_max_count, p_requires_approval) x;
    if v_row.outcome = 'created' and (p_points <> 0 or p_late_policy <> 'full') then
      update private.chores c set points = p_points, late_policy = p_late_policy, late_points = p_late_points
        where c.id = p_id;
      update private.chore_occurrences o
        set points = p_points, late_policy = p_late_policy, late_points = p_late_points
        where o.chore_id = p_id;
    end if;
    return query select v_row.outcome, v_row.occurrence_id, v_row.revision;
  end
  $$;

-- Changing a chore's points (chore managers): prospective. Occurrences created afterwards take the
-- new values; those already created keep theirs (spec), unless a points correction changes one.
-- p_points null keeps the setting; given, p_late_policy is required.
alter function public.update_chore(uuid, integer, text, text, uuid, boolean) set schema private;
alter function private.update_chore(uuid, integer, text, text, uuid, boolean)
  rename to update_chore_before_points;

create function public.update_chore(
  p_chore_id uuid, p_expected_revision integer, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_requires_approval boolean default null,
  p_points integer default null, p_late_policy text default null, p_late_points integer default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
    v_chore private.chores;
  begin
    if (p_points is null) <> (p_late_policy is null)
       or (p_points is not null and not private.valid_chore_points(p_points, p_late_policy, p_late_points))
       or (p_points is null and p_late_points is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_row from private.update_chore_before_points(p_chore_id, p_expected_revision, p_title,
      p_instructions, p_category_id, p_requires_approval) x;
    if v_row.outcome = 'saved' and p_points is not null then
      select * into v_chore from private.chores c where c.id = p_chore_id;
      if v_chore.points <> p_points or v_chore.late_policy <> p_late_policy
         or v_chore.late_points is distinct from p_late_points then
        update private.chores c set points = p_points, late_policy = p_late_policy,
          late_points = p_late_points
          where c.id = p_chore_id;
        perform private.audit_chore('chore.points_changed', v_chore.home_id, 'chore', v_chore.id,
          pg_catalog.jsonb_build_object('points', p_points, 'previous', v_chore.points,
            'policy', p_late_policy));
      end if;
    end if;
    return query select v_row.outcome, v_row.revision;
  end
  $$;

-- Templates carry suggested points.
alter function public.create_chore_template(uuid, uuid, text, text, uuid, integer, jsonb) set schema private;
alter function private.create_chore_template(uuid, uuid, text, text, uuid, integer, jsonb)
  rename to create_chore_template_before_points;

create function public.create_chore_template(
  p_id uuid, p_home_id uuid, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_minutes integer default null, p_steps jsonb default '[]'::jsonb,
  p_points integer default 0, p_late_policy text default 'full', p_late_points integer default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
  begin
    if not private.valid_chore_points(p_points, p_late_policy, p_late_points) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_row from private.create_chore_template_before_points(p_id, p_home_id, p_title,
      p_instructions, p_category_id, p_minutes, p_steps) x;
    if v_row.outcome = 'created' then
      update private.chore_templates t
        set points = p_points, late_policy = p_late_policy, late_points = p_late_points
        where t.id = p_id;
    end if;
    return query select v_row.outcome, v_row.revision;
  end
  $$;

alter function public.update_chore_template(uuid, integer, text, text, uuid, integer, jsonb, boolean)
  set schema private;
alter function private.update_chore_template(uuid, integer, text, text, uuid, integer, jsonb, boolean)
  rename to update_chore_template_before_points;

create function public.update_chore_template(
  p_id uuid, p_expected_revision integer, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_minutes integer default null, p_steps jsonb default '[]'::jsonb,
  p_retired boolean default null,
  p_points integer default null, p_late_policy text default null, p_late_points integer default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
  begin
    if (p_points is null) <> (p_late_policy is null)
       or (p_points is not null and not private.valid_chore_points(p_points, p_late_policy, p_late_points))
       or (p_points is null and p_late_points is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_row from private.update_chore_template_before_points(p_id, p_expected_revision,
      p_title, p_instructions, p_category_id, p_minutes, p_steps, p_retired) x;
    if v_row.outcome = 'saved' and p_points is not null then
      update private.chore_templates t
        set points = p_points, late_policy = p_late_policy, late_points = p_late_points
        where t.id = p_id;
    end if;
    return query select v_row.outcome, v_row.revision;
  end
  $$;

alter function public.list_chore_templates(uuid, boolean) set schema private;
alter function private.list_chore_templates(uuid, boolean) rename to list_chore_templates_before_points;

create function public.list_chore_templates(p_home_id uuid, p_include_retired boolean default false)
returns table (
  id uuid, title text, instructions text, category_id uuid, category_name text, category_color text,
  category_archived boolean, minutes integer, steps jsonb, retired boolean, revision integer,
  points integer, late_policy text, late_points integer
)
  language sql stable security definer set search_path = '' as $$
  select l.id, l.title, l.instructions, l.category_id, l.category_name, l.category_color,
    l.category_archived, l.minutes, l.steps, l.retired, l.revision, t.points, t.late_policy, t.late_points
  from private.list_chore_templates_before_points(p_home_id, p_include_retired) l
  join private.chore_templates t on t.id = l.id;
  $$;

-- What a reopen or a completion correction would do to awarded points, or null when nothing. The
-- new state of the occurrence is given as a whole row.
create function private.chore_points_change(
  p_before private.chore_occurrences, p_after private.chore_occurrences
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_live private.point_entries;
    v_live_user uuid;
    v_want record;
  begin
    v_live := private.live_chore_award(p_before.id);
    select * into v_want from private.desired_chore_award(p_after);
    if v_live.id is not null then
      select a.user_id into v_live_user from private.point_accounts a where a.id = v_live.account_id;
    end if;
    if (v_live.id is null and v_want.amount = 0)
       or (v_live.id is not null and v_want.amount > 0 and v_live_user = v_want.user_id
         and v_live.amount = v_want.amount and v_live.attributed_at = p_after.completed_at
         and v_live.late = v_want.late) then
      return null;
    end if;
    return pg_catalog.jsonb_build_object(
      'fromUser', v_live_user, 'fromAmount', coalesce(v_live.amount, 0),
      'toUser', v_want.user_id, 'toAmount', v_want.amount, 'late', v_want.late);
  end
  $$;

-- The change as a viewer may see it: members by membership id, and the resulting available points
-- of each affected account only for points managers.
create function private.chore_points_change_view(p_home_id uuid, p_change jsonb, p_viewer uuid)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_balances boolean := private.can_manage_points(p_home_id, p_viewer);
    v_from uuid := (p_change ->> 'fromUser')::uuid;
    v_to uuid := (p_change ->> 'toUser')::uuid;
    v_affected jsonb := '[]'::jsonb;
    v_user uuid;
    v_delta integer;
    v_account private.point_accounts;
  begin
    if p_change is null then
      return null;
    end if;
    for v_user in select distinct u from unnest(array[v_from, v_to]) u where u is not null loop
      v_delta := case when v_user = v_to then (p_change ->> 'toAmount')::integer else 0 end
        - case when v_user = v_from then (p_change ->> 'fromAmount')::integer else 0 end;
      if v_delta = 0 then
        continue;
      end if;
      select * into v_account from private.point_accounts a where a.home_id = p_home_id and a.user_id = v_user;
      v_affected := v_affected || pg_catalog.jsonb_build_object(
        'person', private.chore_person(p_home_id, v_user, p_viewer),
        'change', v_delta,
        'availableAfter', case when v_balances
          then coalesce(v_account.balance - v_account.reserved, 0) + v_delta end);
    end loop;
    return pg_catalog.jsonb_build_object(
      'from', private.chore_person(p_home_id, v_from, p_viewer),
      'fromAmount', (p_change ->> 'fromAmount')::integer,
      'to', private.chore_person(p_home_id, v_to, p_viewer),
      'toAmount', (p_change ->> 'toAmount')::integer,
      'late', (p_change ->> 'late')::boolean,
      'affected', v_affected);
  end
  $$;

-- Reopening a completed occurrence that carries points also needs manageHomePoints (spec: "chore-
-- management and reward-adjustment permissions"). Outcome 'points_not_permitted' otherwise.
alter function public.reopen_chore_occurrence(uuid) set schema private;
alter function private.reopen_chore_occurrence(uuid) rename to reopen_chore_occurrence_before_points;

create function public.reopen_chore_occurrence(p_occurrence_id uuid)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is not null and private.can_manage_chores(v_occurrence.home_id, v_user_id)
       and (private.live_chore_award(v_occurrence.id)).id is not null
       and not private.can_manage_points(v_occurrence.home_id, v_user_id) then
      return query select 'points_not_permitted', v_occurrence.revision;
      return;
    end if;
    return query select * from private.reopen_chore_occurrence_before_points(p_occurrence_id);
  end
  $$;

alter function public.correct_chore_completion(uuid, integer, uuid, timestamptz, boolean, text, text)
  set schema private;
alter function private.correct_chore_completion(uuid, integer, uuid, timestamptz, boolean, text, text)
  rename to correct_chore_completion_before_points;

create function public.correct_chore_completion(
  p_occurrence_id uuid, p_expected_revision integer, p_contributor uuid default null,
  p_completed_at timestamptz default null, p_set_note boolean default false, p_note text default null,
  p_reason text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_after private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is not null and private.can_manage_chores(v_occurrence.home_id, v_user_id)
       and v_occurrence.status = 'completed' and v_occurrence.revision = p_expected_revision
       and not private.can_manage_points(v_occurrence.home_id, v_user_id) then
      v_after := v_occurrence;
      if p_contributor is not null then
        select m.user_id into v_after.contributor_id from public.home_memberships m
          where m.home_id = v_occurrence.home_id and m.id = p_contributor;
      end if;
      if p_completed_at is not null and p_completed_at <= pg_catalog.now() + interval '5 minutes' then
        v_after.completed_at := least(p_completed_at, pg_catalog.now());
      end if;
      if v_after.contributor_id is not null
         and private.chore_points_change(v_occurrence, v_after) is not null then
        return query select 'points_not_permitted', v_occurrence.revision;
        return;
      end if;
    end if;
    return query select * from private.correct_chore_completion_before_points(p_occurrence_id,
      p_expected_revision, p_contributor, p_completed_at, p_set_note, p_note, p_reason);
  end
  $$;

-- The point impact of reopening or correcting a completed occurrence, for the confirmation step:
-- p_action 'reopen' or 'correct' (with the correction's contributor, a membership id, and time;
-- null keeps each). Null when it changes no points. Chore managers only; balances after the change
-- only for points managers. 42501 for an occurrence the caller may not see.
create function public.preview_chore_points_change(
  p_occurrence_id uuid, p_action text, p_contributor uuid default null,
  p_completed_at timestamptz default null
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_after private.chore_occurrences;
    v_change jsonb;
  begin
    if p_occurrence_id is null or p_action is null or p_action not in ('reopen', 'correct')
       or (p_action = 'reopen' and (p_contributor is not null or p_completed_at is not null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.chore_occurrences o
      where o.id = p_occurrence_id and o.deleted_at is null;
    if not found or not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    v_after := v_occurrence;
    if p_action = 'reopen' then
      v_after.status := 'open';
      v_after.contributor_id := null;
      v_after.completed_at := null;
    else
      if v_occurrence.status <> 'completed' then
        return null;
      end if;
      if p_contributor is not null then
        select m.user_id into v_after.contributor_id from public.home_memberships m
          where m.home_id = v_occurrence.home_id and m.id = p_contributor;
        if v_after.contributor_id is null then
          return null;
        end if;
      end if;
      if p_completed_at is not null then
        v_after.completed_at := least(p_completed_at, pg_catalog.now());
      end if;
    end if;
    v_change := private.chore_points_change(v_occurrence, v_after);
    if v_change is null then
      return null;
    end if;
    return private.chore_points_change_view(v_occurrence.home_id, v_change, v_user_id)
      || pg_catalog.jsonb_build_object('permitted', private.can_manage_points(v_occurrence.home_id, v_user_id));
  end
  $$;

-- Corrects one occurrence's points snapshot (spec: "unless an authorized user explicitly corrects an
-- eligible occurrence"). Open, pending and claimed occurrences: chore managers. A completed one
-- also needs manageHomePoints and a reason, and its award is reconciled (preview first). Skipped,
-- expired and paused ones earn nothing and are not eligible. p_dry_run returns the impact only.
-- Outcomes: 'preview' and 'saved' (with impact), 'unchanged', 'conflict' (with the current revision),
-- 'not_eligible', 'reason_required', 'points_not_permitted', 'not_found', 'not_permitted'.
create function public.set_chore_occurrence_points(
  p_occurrence_id uuid, p_expected_revision integer, p_points integer, p_late_policy text,
  p_late_points integer default null, p_reason text default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_occurrence private.chore_occurrences;
    v_after private.chore_occurrences;
    v_change jsonb;
    v_impact jsonb;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_dry_run is null
       or not private.valid_chore_points(p_points, p_late_policy, p_late_points)
       or (v_reason is not null and not private.is_plain_text(v_reason, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_occurrence.status not in ('open', 'pending_approval', 'completed') then
      return query select 'not_eligible', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.points = p_points and v_occurrence.late_policy = p_late_policy
       and v_occurrence.late_points is not distinct from p_late_points then
      return query select 'unchanged', null::jsonb, v_occurrence.revision;
      return;
    end if;
    v_after := v_occurrence;
    v_after.points := p_points;
    v_after.late_policy := p_late_policy;
    v_after.late_points := p_late_points;
    v_change := private.chore_points_change(v_occurrence, v_after);
    if v_change is not null and not private.can_manage_points(v_occurrence.home_id, v_user_id) then
      return query select 'points_not_permitted', null::jsonb, v_occurrence.revision;
      return;
    end if;
    v_impact := pg_catalog.jsonb_build_object('points', p_points, 'previousPoints', v_occurrence.points,
      'change', private.chore_points_change_view(v_occurrence.home_id, v_change, v_user_id));
    if p_dry_run then
      return query select 'preview', v_impact, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status = 'completed' and v_reason is null then
      return query select 'reason_required', v_impact, v_occurrence.revision;
      return;
    end if;
    update private.chore_occurrences o
      set points = p_points, late_policy = p_late_policy, late_points = p_late_points,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id, reason, points, previous_points)
      values (v_occurrence.id, 'points_corrected', v_user_id, v_reason, p_points,
        (v_impact ->> 'previousPoints')::integer);
    perform private.audit_chore('chore_occurrence.points_corrected', v_occurrence.home_id,
      'chore_occurrence', v_occurrence.id, pg_catalog.jsonb_build_object(
        'points', p_points, 'previous', (v_impact ->> 'previousPoints')::integer,
        'awardChanged', v_change is not null));
    return query select 'saved', v_impact, v_occurrence.revision;
  end
  $$;

-- An occurrence's points as a member of its Home sees them: the base value and policy, the chore's
-- current setting (with how many created open occurrences keep a different value), what completing
-- now would earn, the pending award of a submission waiting for review, the live award, and its
-- ledger lines (amount, kind, member, late; never balances). Null when the caller may not see it.
create function public.get_chore_points(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_submission private.chore_submissions;
    v_live private.point_entries;
    v_live_user uuid;
    v_today date;
    v_late_now boolean;
    v_manage boolean;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.chore_occurrences o
      where o.id = p_occurrence_id and o.deleted_at is null;
    if not found or not private.is_home_member(v_occurrence.home_id, v_user_id) then
      return null;
    end if;
    select * into v_chore from private.chores c where c.id = v_occurrence.chore_id and c.deleted_at is null;
    if not found then
      return null;
    end if;
    v_manage := private.can_manage_chores(v_occurrence.home_id, v_user_id);
    v_today := private.task_today(v_occurrence.home_id, null);
    v_late_now := v_today > v_occurrence.due_date;
    select * into v_submission from private.chore_submissions s
      where s.occurrence_id = v_occurrence.id and s.status = 'pending';
    v_live := private.live_chore_award(v_occurrence.id);
    if v_live.id is not null then
      select a.user_id into v_live_user from private.point_accounts a where a.id = v_live.account_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'points', v_occurrence.points,
      'latePolicy', v_occurrence.late_policy,
      'latePoints', v_occurrence.late_points,
      'lateNow', v_late_now and v_occurrence.status = 'open',
      'expectedNow', private.chore_award(v_occurrence.points, v_occurrence.late_policy,
        v_occurrence.late_points, v_late_now),
      'chore', pg_catalog.jsonb_build_object(
        'points', v_chore.points, 'latePolicy', v_chore.late_policy, 'latePoints', v_chore.late_points,
        'revision', v_chore.revision,
        'scheduledOther', case when v_manage then (select count(*)::integer
          from private.chore_occurrences o2 where o2.chore_id = v_chore.id and o2.deleted_at is null
            and o2.status = 'open' and (o2.points <> v_chore.points
              or o2.late_policy <> v_chore.late_policy
              or o2.late_points is distinct from v_chore.late_points)) end),
      'pending', case when v_submission.id is not null then pg_catalog.jsonb_build_object(
        'person', private.chore_person(v_occurrence.home_id, v_submission.contributor_id, v_user_id),
        'amount', private.chore_award(v_occurrence.points, v_occurrence.late_policy,
          v_occurrence.late_points, private.chore_late(v_occurrence.home_id, v_occurrence.due_date,
            v_submission.submitted_at)),
        'late', private.chore_late(v_occurrence.home_id, v_occurrence.due_date, v_submission.submitted_at))
        end,
      'awarded', case when v_live.id is not null then pg_catalog.jsonb_build_object(
        'person', private.chore_person(v_occurrence.home_id, v_live_user, v_user_id),
        'amount', v_live.amount, 'late', v_live.late, 'at', v_live.attributed_at) end,
      'entries', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind', e.kind, 'amount', e.amount, 'late', e.late, 'createdAt', e.created_at,
          'person', private.chore_person(v_occurrence.home_id, a.user_id, v_user_id))
          order by e.seq)
        from private.point_entries e join private.point_accounts a on a.id = e.account_id
        where e.occurrence_id = v_occurrence.id), '[]'::jsonb),
      'canCorrect', v_manage and v_occurrence.status in ('open', 'pending_approval', 'completed'),
      'canCorrectAwarded', v_manage and private.can_manage_points(v_occurrence.home_id, v_user_id));
  end
  $$;

-- Points of many occurrences of one Home at once (cards, the pool, the schedule): base value,
-- policy, and the award each completed one carries. Ids outside the Home are left out.
create function public.list_chore_points(p_home_id uuid, p_occurrence_ids uuid[])
returns table (occurrence_id uuid, points integer, late_policy text, late_points integer, awarded integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_occurrence_ids is null or cardinality(p_occurrence_ids) > 500 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query
      select o.id, o.points, o.late_policy, o.late_points, (private.live_chore_award(o.id)).amount
      from private.chore_occurrences o
      where o.home_id = p_home_id and o.id = any (p_occurrence_ids) and o.deleted_at is null;
  end
  $$;

-- Periods -----------------------------------------------------------------------------------------------

-- The Home-local bounds of a period holding p_today: 'week' (the Home's chore week), 'month', 'year',
-- 'all' (every time). Ends exclusive.
create function private.point_period(p_home_id uuid, p_period text, p_today date)
returns table (starts_on date, ends_on date, starts_at timestamptz, ends_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_zone text := private.home_zone(p_home_id);
    v_start date;
    v_end date;
  begin
    if p_period = 'week' then
      v_start := private.chore_week_start((private.chore_settings(p_home_id)).week_start, p_today);
      v_end := v_start + 7;
    elsif p_period = 'month' then
      v_start := pg_catalog.date_trunc('month', p_today::timestamp)::date;
      v_end := (v_start + interval '1 month')::date;
    elsif p_period = 'year' then
      v_start := pg_catalog.date_trunc('year', p_today::timestamp)::date;
      v_end := (v_start + interval '1 year')::date;
    else
      return query select null::date, null::date, '-infinity'::timestamptz, 'infinity'::timestamptz;
      return;
    end if;
    return query select v_start, v_end, (v_start::timestamp at time zone v_zone),
      (v_end::timestamp at time zone v_zone);
  end
  $$;

-- Points summaries ----------------------------------------------------------------------------------------

-- Totals of one account: available, reserved, balance, earned, spent; owed when available < 0.
create function private.point_totals(p_account private.point_accounts) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'available', coalesce(p_account.balance - p_account.reserved, 0),
    'reserved', coalesce(p_account.reserved, 0),
    'balance', coalesce(p_account.balance, 0),
    'earned', coalesce((select sum(e.amount) from private.point_entries e where e.account_id = p_account.id
      and e.kind in ('chore_award', 'chore_reversal', 'bonus', 'correction', 'manual_reversal')), 0),
    'spent', coalesce((select -sum(e.amount) from private.point_entries e where e.account_id = p_account.id
      and e.kind in ('redemption', 'refund')), 0),
    'owed', coalesce(p_account.balance - p_account.reserved, 0) < 0);
  $$;

-- Chore points of one member in a period: earned (awards less reversals attributed in it), pending
-- (submissions waiting for review, reported in it, as they would be awarded) and possible (their open
-- assigned occurrences due in it, on time).
create function private.chore_points_in(p_home_id uuid, p_user_id uuid, p_starts_on date, p_ends_on date)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'earned', coalesce((select sum(e.amount) from private.point_entries e
      join private.point_accounts a on a.id = e.account_id
      where a.home_id = p_home_id and a.user_id = p_user_id
        and e.kind in ('chore_award', 'chore_reversal')
        and e.attributed_at >= (p_starts_on::timestamp at time zone private.home_zone(p_home_id))
        and e.attributed_at < (p_ends_on::timestamp at time zone private.home_zone(p_home_id))), 0),
    'pending', coalesce((select sum(private.chore_award(o.points, o.late_policy, o.late_points,
        private.chore_late(o.home_id, o.due_date, s.submitted_at)))
      from private.chore_submissions s join private.chore_occurrences o on o.id = s.occurrence_id
      join private.chores c on c.id = o.chore_id
      where s.home_id = p_home_id and s.status = 'pending' and s.contributor_id = p_user_id
        and o.deleted_at is null and c.deleted_at is null
        and (s.submitted_at at time zone private.home_zone(p_home_id))::date >= p_starts_on
        and (s.submitted_at at time zone private.home_zone(p_home_id))::date < p_ends_on), 0),
    'possible', coalesce((select sum(o.points) from private.chore_occurrences o
      join private.chores c on c.id = o.chore_id
      join private.chore_occurrence_assignees x on x.occurrence_id = o.id and x.user_id = p_user_id
      where o.home_id = p_home_id and o.status = 'open' and o.deleted_at is null and c.deleted_at is null
        and o.due_date >= p_starts_on and o.due_date < p_ends_on), 0));
  $$;

-- The caller's points in one Home: totals, this week's chore points, their target, participation,
-- what they may do, and counts of work waiting for them. 42501 for a Home the caller is not in.
create function public.get_point_summary(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_account private.point_accounts;
    v_prefs private.point_preferences;
    v_settings private.point_settings;
    v_week record;
    v_rewards boolean;
    v_approve boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    select * into v_account from private.point_accounts a where a.home_id = p_home_id and a.user_id = v_user_id;
    select * into v_prefs from private.point_preferences p where p.home_id = p_home_id and p.user_id = v_user_id;
    select * into v_settings from private.point_settings s where s.home_id = p_home_id;
    select * into v_week from private.point_period(p_home_id, 'week', private.task_today(p_home_id, null));
    v_rewards := private.can_manage_rewards(p_home_id, v_user_id);
    v_approve := private.can_approve_rewards(p_home_id, v_user_id);
    return pg_catalog.jsonb_build_object(
      'accountId', v_account.id,
      'totals', private.point_totals(v_account),
      'week', pg_catalog.jsonb_build_object('startsOn', v_week.starts_on, 'endsOn', v_week.ends_on - 1)
        || private.chore_points_in(p_home_id, v_user_id, v_week.starts_on, v_week.ends_on),
      'participates', coalesce(v_prefs.participates, true),
      'target', v_prefs.target,
      'targetPaused', coalesce(v_prefs.target_paused, false),
      'shareTarget', coalesce(v_prefs.share_target, false),
      'leaderboardEnabled', coalesce(v_settings.leaderboard_enabled, false),
      'defaultPeriod', coalesce(v_settings.default_period, 'month'),
      'canManagePoints', private.can_manage_points(p_home_id, v_user_id),
      'canManageRewards', v_rewards,
      'canApproveRewards', v_approve,
      'pendingApprovals', case when v_approve then (select count(*)::integer
        from private.reward_redemptions r where r.home_id = p_home_id and r.status = 'pending'
          and r.requested_by is distinct from v_user_id) else 0 end,
      'openFulfillment', case when v_rewards then (select count(*)::integer
        from private.reward_redemptions r where r.home_id = p_home_id and r.status = 'redeemed'
          and (r.fulfillment = 'pending' or (r.fulfillment = 'unable' and (r.resolution is null
            or (r.resolution = 'replacement' and r.replacement_status in ('pending', 'unable'))))))
        else 0 end,
      'myPendingRequests', (select count(*)::integer from private.reward_redemptions r
        where r.account_id = v_account.id and r.status = 'pending'));
  end
  $$;

-- One page of an account's ledger, newest first (p_before: a seq from the previous page). p_account
-- null: the caller's own. Another account: points managers only. Reasons are shown to the account's
-- holder and to points managers (both may read the account). 42501 when the caller may not read it.
create function public.list_point_entries(
  p_home_id uuid, p_account_id uuid default null, p_before bigint default null,
  p_limit integer default 50
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_account private.point_accounts;
    v_limit integer := least(greatest(coalesce(p_limit, 50), 1), private.points_limit('page'));
    v_manage boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_account_id is null then
      select * into v_account from private.point_accounts a where a.home_id = p_home_id and a.user_id = v_user_id;
      if not found then
        return pg_catalog.jsonb_build_object('account', null, 'entries', '[]'::jsonb, 'next', null);
      end if;
    else
      select * into v_account from private.point_accounts a where a.id = p_account_id and a.home_id = p_home_id;
      if not found or not private.can_view_point_account(v_account, v_user_id) then
        raise exception 'not permitted' using errcode = '42501';
      end if;
    end if;
    v_manage := private.can_manage_points(p_home_id, v_user_id);
    return (
      with page as (
        select e.* from private.point_entries e
        where e.account_id = v_account.id and (p_before is null or e.seq < p_before)
        order by e.seq desc limit v_limit + 1
      )
      select pg_catalog.jsonb_build_object(
        'account', pg_catalog.jsonb_build_object('id', v_account.id,
          'person', private.chore_person(p_home_id, v_account.user_id, v_user_id),
          'former', v_account.user_id is null or not private.is_home_member(p_home_id, v_account.user_id))
          || private.point_totals(v_account),
        'entries', coalesce((select pg_catalog.jsonb_agg(x.item order by x.seq desc) from (
          select p.seq, pg_catalog.jsonb_build_object(
            'id', p.id, 'seq', p.seq, 'kind', p.kind, 'amount', p.amount, 'late', p.late,
            'attributedAt', p.attributed_at, 'createdAt', p.created_at, 'reason', p.reason,
            'actor', private.chore_person(p_home_id, p.actor_id, v_user_id),
            'availableBefore', p.available_before, 'availableAfter', p.available_after,
            'reservedAfter', p.reserved_after,
            'occurrence', case when p.occurrence_id is not null then (
              select pg_catalog.jsonb_build_object('id', o.id,
                'title', coalesce(o.closed_title, c.title), 'scheduledDate', o.scheduled_date)
              from private.chore_occurrences o join private.chores c on c.id = o.chore_id
              where o.id = p.occurrence_id) end,
            'redemption', case when p.redemption_id is not null then (
              select pg_catalog.jsonb_build_object('id', r.id, 'rewardName', r.reward_name)
              from private.reward_redemptions r where r.id = p.redemption_id) end,
            'reverses', p.reverses_id,
            'reversed', exists (select 1 from private.point_entries r where r.reverses_id = p.id),
            'canReverse', v_manage and p.kind in ('bonus', 'correction')
              and not exists (select 1 from private.point_entries r where r.reverses_id = p.id)
          ) as item
          from page p order by p.seq desc limit v_limit
        ) x), '[]'::jsonb),
        'next', case when (select count(*) from page) > v_limit
          then (select min(q.seq) from (select p.seq from page p order by p.seq desc limit v_limit) q) end));
  end
  $$;

-- Every account of the Home with its totals (points managers only), current members first; former
-- members' preserved accounts follow without a name. 42501 otherwise.
create function public.list_point_accounts(p_home_id uuid)
returns table (account_id uuid, member_id uuid, former boolean, totals jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if not private.can_manage_points(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select a.id, m.id, m.id is null, private.point_totals(a)
      from private.point_accounts a
      left join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
      where a.home_id = p_home_id
      union all
      -- Members without an account yet show zero totals.
      select null::uuid, m.id, false, private.point_totals(null::private.point_accounts)
      from public.home_memberships m
      where m.home_id = p_home_id and not exists (
        select 1 from private.point_accounts a where a.home_id = m.home_id and a.user_id = m.user_id)
      order by 3, 2;
  end
  $$;

-- Manual adjustments ----------------------------------------------------------------------------------------

-- A bonus (positive) or correction (either sign) to a current member's account (points managers;
-- spec "Confirmed manual reward point bonuses and adjustments"). p_id comes from the client, so a
-- retry returns 'exists'. A meaningful reason (3-300 characters) is required. A debit never takes
-- available points below zero and never touches reserved points ('insufficient_points', nothing
-- applied). p_dry_run returns the preview: the member, the change, available and reserved now and
-- available after. Outcomes: 'preview', 'posted', 'exists', 'insufficient_points',
-- 'member_unavailable', 'not_permitted'.
create function public.adjust_points(
  p_id uuid, p_home_id uuid, p_member uuid, p_kind text, p_amount integer, p_reason text,
  p_dry_run boolean default false
) returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_target uuid;
    v_account private.point_accounts;
    v_existing private.point_entries;
    v_entry private.point_entries;
    v_preview jsonb;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_member is null or p_kind is null or p_kind not in ('bonus', 'correction')
       or p_amount is null or p_amount = 0 or abs(p_amount) > private.points_limit('adjustment')
       or (p_kind = 'bonus' and p_amount < 0) or p_dry_run is null
       or v_reason is null or pg_catalog.char_length(v_reason) < private.points_limit('reason_min')
       or not private.is_plain_text(v_reason, private.points_limit('reason')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_points(p_home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::uuid;
      return;
    end if;
    select * into v_existing from private.point_entries e where e.id = p_id;
    if found then
      if v_existing.home_id <> p_home_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', null::jsonb, v_existing.id;
      return;
    end if;
    select m.user_id into v_target from public.home_memberships m where m.home_id = p_home_id and m.id = p_member;
    if v_target is null then
      return query select 'member_unavailable', null::jsonb, null::uuid;
      return;
    end if;
    v_account := private.lock_point_account(p_home_id, v_target);
    v_preview := pg_catalog.jsonb_build_object(
      'person', private.chore_person(p_home_id, v_target, v_user_id), 'kind', p_kind, 'amount', p_amount,
      'available', v_account.balance - v_account.reserved, 'reserved', v_account.reserved,
      'availableAfter', v_account.balance - v_account.reserved + p_amount);
    if p_amount < 0 and v_account.balance - v_account.reserved + p_amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_entry := private.post_point_entry(v_account.id, p_kind, p_amount, null, null, null, null, v_reason,
      v_user_id, null, p_id);
    perform private.notify_point_adjustment(v_entry);
    perform private.audit('point_entry.adjusted', p_home_id, 'point_entry', v_entry.id,
      pg_catalog.jsonb_build_object('kind', p_kind, 'amount', p_amount));
    return query select 'posted', v_preview, v_entry.id;
  end
  $$;

-- Reverses one bonus or correction with a new linked entry (points managers), once. The reversal
-- follows the same rule as a debit. Outcomes: 'preview', 'reversed', 'already_reversed',
-- 'not_reversible', 'insufficient_points', 'member_unavailable', 'not_found', 'not_permitted'.
create function public.reverse_point_entry(
  p_entry_id uuid, p_reason text, p_dry_run boolean default false
) returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_original private.point_entries;
    v_account private.point_accounts;
    v_reversal private.point_entries;
    v_entry private.point_entries;
    v_preview jsonb;
  begin
    if p_entry_id is null or p_dry_run is null or v_reason is null
       or pg_catalog.char_length(v_reason) < private.points_limit('reason_min')
       or not private.is_plain_text(v_reason, private.points_limit('reason')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_original from private.point_entries e where e.id = p_entry_id;
    if not found or not private.is_home_member(v_original.home_id, v_user_id) then
      return query select 'not_found', null::jsonb, null::uuid;
      return;
    end if;
    if not private.can_manage_points(v_original.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::uuid;
      return;
    end if;
    if v_original.kind not in ('bonus', 'correction') then
      return query select 'not_reversible', null::jsonb, null::uuid;
      return;
    end if;
    perform private.lock_points_home(v_original.home_id);
    select * into v_account from private.point_accounts a where a.id = v_original.account_id for update;
    if v_account.user_id is null or not private.is_home_member(v_account.home_id, v_account.user_id) then
      return query select 'member_unavailable', null::jsonb, null::uuid;
      return;
    end if;
    select * into v_reversal from private.point_entries e where e.reverses_id = v_original.id;
    if found then
      return query select 'already_reversed', null::jsonb, v_reversal.id;
      return;
    end if;
    v_preview := pg_catalog.jsonb_build_object(
      'person', private.chore_person(v_account.home_id, v_account.user_id, v_user_id),
      'kind', 'manual_reversal', 'amount', -v_original.amount,
      'available', v_account.balance - v_account.reserved, 'reserved', v_account.reserved,
      'availableAfter', v_account.balance - v_account.reserved - v_original.amount);
    if v_original.amount > 0 and v_account.balance - v_account.reserved - v_original.amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_entry := private.post_point_entry(v_account.id, 'manual_reversal', -v_original.amount,
      v_original.attributed_at, null, null, v_original.id, v_reason, v_user_id, null);
    perform private.notify_point_adjustment(v_entry);
    perform private.audit('point_entry.reversed', v_account.home_id, 'point_entry', v_entry.id,
      pg_catalog.jsonb_build_object('reverses', v_original.id, 'amount', -v_original.amount));
    return query select 'reversed', v_preview, v_entry.id;
  end
  $$;

-- Preferences, settings, leaderboard, weekly overview -------------------------------------------------------

-- The caller's own choices in one Home (any member; spec: no manager may impose or override them).
-- Each part is optional: p_participates, p_set_target with p_target (null or 0 removes it),
-- p_target_paused, p_share_target. Outcome 'saved'.
create function public.update_point_preferences(
  p_home_id uuid, p_participates boolean default null, p_set_target boolean default false,
  p_target integer default null, p_target_paused boolean default null, p_share_target boolean default null
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_set_target is null or (not p_set_target and p_target is not null)
       or (p_target is not null and p_target not between 0 and private.points_limit('target')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    insert into private.point_preferences (home_id, user_id) values (p_home_id, v_user_id)
      on conflict (home_id, user_id) do nothing;
    update private.point_preferences p
      set participates = coalesce(p_participates, p.participates),
        target = case when p_set_target then nullif(p_target, 0) else p.target end,
        target_paused = case when p_set_target and nullif(p_target, 0) is null then false
          else coalesce(p_target_paused, p.target_paused) end,
        share_target = coalesce(p_share_target, p.share_target),
        updated_at = pg_catalog.now()
      where p.home_id = p_home_id and p.user_id = v_user_id;
    return 'saved';
  end
  $$;

-- The Home's leaderboard settings (rewards managers): on/off and the default period, set to state
-- (a retry or two managers saving at once leave the last choice). Every member reads them through
-- get_point_summary. Outcomes: 'saved', 'not_permitted'.
create function public.update_point_settings(
  p_home_id uuid, p_leaderboard_enabled boolean, p_default_period text
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_leaderboard_enabled is null or p_default_period is null
       or p_default_period not in ('week', 'month', 'all') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_rewards(p_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    insert into private.point_settings (home_id, leaderboard_enabled, default_period, updated_by)
      values (p_home_id, p_leaderboard_enabled, p_default_period, v_user_id)
      on conflict (home_id) do update
        set leaderboard_enabled = excluded.leaderboard_enabled, default_period = excluded.default_period,
          revision = private.point_settings.revision + 1, updated_by = excluded.updated_by,
          updated_at = pg_catalog.now();
    perform private.audit('point_settings.changed', p_home_id, 'point_settings', p_home_id,
      pg_catalog.jsonb_build_object('leaderboard', p_leaderboard_enabled, 'period', p_default_period));
    return 'saved';
  end
  $$;

-- The leaderboard for a period (null: the Home's default), when the Home turned it on: every current
-- member who participates, ranked by earned points attributed in the period, then by completed
-- occurrences in it (as actual contributor, by completion time), then sharing a rank (1, 1, 3).
-- Nobody who opted out appears or is counted. Never balances, reservations or reasons. 42501 for a
-- Home the caller is not in.
create function public.get_point_leaderboard(p_home_id uuid, p_period text default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_settings private.point_settings;
    v_period text;
    v_bounds record;
    v_first timestamptz;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_period is not null and p_period not in ('week', 'month', 'all') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_settings from private.point_settings s where s.home_id = p_home_id;
    v_period := coalesce(p_period, v_settings.default_period, 'month');
    if not coalesce(v_settings.leaderboard_enabled, false) then
      return pg_catalog.jsonb_build_object('enabled', false, 'period', v_period,
        'defaultPeriod', coalesce(v_settings.default_period, 'month'), 'rows', '[]'::jsonb);
    end if;
    select * into v_bounds from private.point_period(p_home_id, v_period, private.task_today(p_home_id, null));
    if v_period = 'all' then
      select min(e.attributed_at) into v_first from private.point_entries e where e.home_id = p_home_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'enabled', true, 'period', v_period,
      'defaultPeriod', v_settings.default_period,
      'startsOn', case when v_period = 'all'
        then (v_first at time zone private.home_zone(p_home_id))::date else v_bounds.starts_on end,
      'endsOn', case when v_period = 'all' then null else v_bounds.ends_on - 1 end,
      'participates', coalesce((select p.participates from private.point_preferences p
        where p.home_id = p_home_id and p.user_id = v_user_id), true),
      'rows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'member', r.member_id, 'me', r.user_id = v_user_id, 'earned', r.earned,
          'completed', r.completed, 'rank', r.rank) order by r.rank, r.member_id)
        from (
          select s.*, rank() over (order by s.earned desc, s.completed desc)::integer as rank
          from (
            select m.id as member_id, m.user_id,
              coalesce((select sum(e.amount) from private.point_entries e
                join private.point_accounts a on a.id = e.account_id
                where a.home_id = p_home_id and a.user_id = m.user_id
                  and e.kind in ('chore_award', 'chore_reversal', 'bonus', 'correction', 'manual_reversal')
                  and e.attributed_at >= v_bounds.starts_at and e.attributed_at < v_bounds.ends_at), 0)::integer
                as earned,
              (select count(*) from private.chore_occurrences o join private.chores c on c.id = o.chore_id
                where o.home_id = p_home_id and o.status = 'completed' and o.deleted_at is null
                  and c.deleted_at is null and o.contributor_id = m.user_id
                  and o.completed_at >= v_bounds.starts_at and o.completed_at < v_bounds.ends_at)::integer
                as completed
            from public.home_memberships m
            where m.home_id = p_home_id and coalesce((select p.participates from private.point_preferences p
              where p.home_id = m.home_id and p.user_id = m.user_id), true)
          ) s
        ) r), '[]'::jsonb));
  end
  $$;

-- The weekly points overview of a Home's current week (or the week holding p_date): the caller's own
-- earned, pending and possible chore points and target; with p_shared, every participating current
-- member's earned, pending and possible points (targets only when shared), and the possible points
-- of unassigned open occurrences as a separate total. Never a ranking. 42501 for a Home the caller
-- is not in.
create function public.get_weekly_points(p_home_id uuid, p_shared boolean default false, p_date date default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_week record;
    v_prefs private.point_preferences;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_shared is null or (p_date is not null and p_date not between date '2000-01-01' and date '2199-12-31') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_week from private.point_period(p_home_id, 'week',
      coalesce(p_date, private.task_today(p_home_id, null)));
    select * into v_prefs from private.point_preferences p where p.home_id = p_home_id and p.user_id = v_user_id;
    return pg_catalog.jsonb_build_object(
      'startsOn', v_week.starts_on, 'endsOn', v_week.ends_on - 1,
      'me', private.chore_points_in(p_home_id, v_user_id, v_week.starts_on, v_week.ends_on)
        || pg_catalog.jsonb_build_object('target', case when not coalesce(v_prefs.target_paused, false)
          then v_prefs.target end),
      'members', case when p_shared then coalesce((select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('member', m.id, 'me', m.user_id = v_user_id,
            'target', case when (m.user_id = v_user_id or coalesce(p.share_target, false))
              and not coalesce(p.target_paused, false) then p.target end)
          || private.chore_points_in(p_home_id, m.user_id, v_week.starts_on, v_week.ends_on)
          order by m.id)
        from public.home_memberships m
        left join private.point_preferences p on p.home_id = m.home_id and p.user_id = m.user_id
        where m.home_id = p_home_id and coalesce(p.participates, true)), '[]'::jsonb) end,
      'unassignedPossible', case when p_shared then coalesce((select sum(o.points)
        from private.chore_occurrences o join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.status = 'open' and o.deleted_at is null and c.deleted_at is null
          and o.due_date >= v_week.starts_on and o.due_date < v_week.ends_on
          and not exists (select 1 from private.chore_occurrence_assignees x where x.occurrence_id = o.id)), 0)
        end);
  end
  $$;

-- Rewards -------------------------------------------------------------------------------------------------

-- The first day of the per-member period holding p_today (null for 'ever'), and of the next one.
create function private.reward_period_start(p_home_id uuid, p_period text, p_today date) returns date
  language sql stable security definer set search_path = '' as $$
  select case when p_period = 'ever' then null
    else (select x.starts_on from private.point_period(p_home_id, p_period, p_today) x) end;
  $$;

create function private.reward_period_next(p_home_id uuid, p_period text, p_today date) returns date
  language sql stable security definer set search_path = '' as $$
  select case when p_period = 'ever' then null
    else (select x.ends_on from private.point_period(p_home_id, p_period, p_today) x) end;
  $$;

-- How many requests count against the reward's total, and against one account in the current period.
create function private.reward_total_used(p_reward_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.reward_redemptions r
  where r.reward_id = p_reward_id and r.status in ('pending', 'redeemed');
  $$;

create function private.reward_member_used(p_reward private.rewards, p_account_id uuid, p_today date)
returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.reward_redemptions r
  where r.reward_id = p_reward.id and r.account_id = p_account_id and r.status in ('pending', 'redeemed')
    and (p_reward.member_period = 'ever'
      or (r.requested_at at time zone private.home_zone(p_reward.home_id))::date
        >= private.reward_period_start(p_reward.home_id, p_reward.member_period, p_today));
  $$;

-- Why p_account cannot redeem the reward now, or null: 'archived', 'disabled', 'not_started',
-- 'ended', 'sold_out', 'member_limit'.
create function private.reward_block(p_reward private.rewards, p_account_id uuid, p_today date) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_reward.archived_at is not null then 'archived'
    when not p_reward.enabled then 'disabled'
    when p_reward.available_from is not null and p_today < p_reward.available_from then 'not_started'
    when p_reward.available_until is not null and p_today > p_reward.available_until then 'ended'
    when p_reward.total_limit is not null and private.reward_total_used(p_reward.id) >= p_reward.total_limit
      then 'sold_out'
    when p_reward.member_limit is not null and p_account_id is not null
      and private.reward_member_used(p_reward, p_account_id, p_today) >= p_reward.member_limit
      then 'member_limit'
  end;
  $$;

-- A reward as p_viewer sees it.
create function private.reward_json(p_reward private.rewards, p_viewer uuid, p_manage boolean) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.task_today(p_reward.home_id, null);
    v_account private.point_accounts;
    v_block text;
    v_used integer;
  begin
    select * into v_account from private.point_accounts a
      where a.home_id = p_reward.home_id and a.user_id = p_viewer;
    v_block := private.reward_block(p_reward, v_account.id, v_today);
    v_used := case when p_reward.member_limit is not null and v_account.id is not null
      then private.reward_member_used(p_reward, v_account.id, v_today) else 0 end;
    return pg_catalog.jsonb_build_object(
      'id', p_reward.id, 'name', p_reward.name, 'description', p_reward.description,
      'cost', p_reward.cost, 'requiresApproval', p_reward.requires_approval, 'enabled', p_reward.enabled,
      'availableFrom', p_reward.available_from, 'availableUntil', p_reward.available_until,
      'totalLimit', p_reward.total_limit, 'memberLimit', p_reward.member_limit,
      'memberPeriod', p_reward.member_period, 'archived', p_reward.archived_at is not null,
      'revision', p_reward.revision,
      'block', v_block,
      'remaining', case when p_reward.total_limit is not null
        then greatest(p_reward.total_limit - private.reward_total_used(p_reward.id), 0) end,
      'myUsed', v_used,
      'nextEligibleOn', case when v_block = 'member_limit'
        then private.reward_period_next(p_reward.home_id, p_reward.member_period, v_today) end,
      'canAfford', coalesce(v_account.balance - v_account.reserved, 0) >= p_reward.cost,
      'pendingCount', case when p_manage then (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = p_reward.id and r.status = 'pending') end,
      'redeemedCount', case when p_manage then (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = p_reward.id and r.status = 'redeemed') end);
  end
  $$;

-- The Home's rewards: the enabled, not archived catalog for every member; every reward (archived
-- ones when asked) for rewards managers. By cost, then name. 42501 for a Home the caller is not in.
create function public.list_rewards(p_home_id uuid, p_include_archived boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_manage boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_manage := private.can_manage_rewards(p_home_id, v_user_id);
    return coalesce((select pg_catalog.jsonb_agg(private.reward_json(r, v_user_id, v_manage)
        order by r.cost, private.task_name_key(r.name), r.id)
      from private.rewards r
      where r.home_id = p_home_id
        and (v_manage or (r.enabled and r.archived_at is null))
        and (r.archived_at is null or (v_manage and coalesce(p_include_archived, false)))), '[]'::jsonb);
  end
  $$;

-- Validates reward fields (22023 when invalid).
create function private.check_reward_fields(
  p_name text, p_description text, p_cost integer, p_requires_approval boolean, p_enabled boolean,
  p_available_from date, p_available_until date, p_total_limit integer, p_member_limit integer,
  p_member_period text
) returns void
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_name is null or not private.is_visible_name(p_name, private.points_limit('reward_name'))
       or (p_description is not null
         and not private.is_plain_text(p_description, private.points_limit('reward_description')))
       or p_cost is null or p_cost not between 1 and private.points_limit('cost')
       or p_requires_approval is null or p_enabled is null
       or (p_available_from is not null and p_available_from not between date '2000-01-01' and date '2199-12-31')
       or (p_available_until is not null and p_available_until not between date '2000-01-01' and date '2199-12-31')
       or p_available_until < p_available_from
       or (p_total_limit is not null and p_total_limit not between 1 and private.points_limit('total_limit'))
       or (p_member_limit is null) <> (p_member_period is null)
       or (p_member_limit is not null and p_member_limit not between 1 and private.points_limit('member_limit'))
       or (p_member_period is not null and p_member_period not in ('week', 'month', 'year', 'ever')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
  end
  $$;

-- Creates a reward (rewards managers). p_id comes from the client, so a retry returns 'exists'.
-- Outcomes: 'created', 'exists', 'limit_reached', 'not_permitted'.
create function public.create_reward(
  p_id uuid, p_home_id uuid, p_name text, p_cost integer, p_description text default null,
  p_requires_approval boolean default false, p_enabled boolean default true,
  p_available_from date default null, p_available_until date default null,
  p_total_limit integer default null, p_member_limit integer default null, p_member_period text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_description text := nullif(pg_catalog.btrim(p_description, E' \t\r\n'), '');
    v_existing private.rewards;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.check_reward_fields(p_name, v_description, p_cost, p_requires_approval, p_enabled,
      p_available_from, p_available_until, p_total_limit, p_member_limit, p_member_period);
    if not private.can_manage_rewards(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_existing from private.rewards r where r.id = p_id;
    if found then
      if v_existing.home_id <> p_home_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', v_existing.revision;
      return;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rewards:' || p_home_id::text, 0));
    if (select count(*) from private.rewards r where r.home_id = p_home_id and r.archived_at is null)
       >= private.points_limit('rewards') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.rewards (
      id, home_id, name, description, cost, requires_approval, enabled, available_from, available_until,
      total_limit, member_limit, member_period, created_by, updated_by
    ) values (
      p_id, p_home_id, p_name, v_description, p_cost, p_requires_approval, p_enabled, p_available_from,
      p_available_until, p_total_limit, p_member_limit, p_member_period, v_user_id, v_user_id
    );
    perform private.audit('rewards.created', p_home_id, 'reward', p_id,
      pg_catalog.jsonb_build_object('cost', p_cost, 'approval', p_requires_approval));
    return query select 'created', 1;
  end
  $$;

-- Changes a reward (rewards managers): every field at once, as the form shows them. Pending requests
-- keep their cost and reservation; completed redemptions never change; a lower limit applies to new
-- requests only. p_dry_run returns the impact: pending and redeemed counts, and whether the new
-- limits are already reached. Outcomes: 'preview', 'saved' (with impact), 'conflict' (with the
-- current revision), 'archived', 'not_found', 'not_permitted'.
create function public.update_reward(
  p_reward_id uuid, p_expected_revision integer, p_name text, p_cost integer,
  p_description text default null, p_requires_approval boolean default false, p_enabled boolean default true,
  p_available_from date default null, p_available_until date default null,
  p_total_limit integer default null, p_member_limit integer default null, p_member_period text default null,
  p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_description text := nullif(pg_catalog.btrim(p_description, E' \t\r\n'), '');
    v_reward private.rewards;
    v_impact jsonb;
    v_used integer;
  begin
    if p_reward_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.check_reward_fields(p_name, v_description, p_cost, p_requires_approval, p_enabled,
      p_available_from, p_available_until, p_total_limit, p_member_limit, p_member_period);
    perform private.lock_points_home((select r.home_id from private.rewards r where r.id = p_reward_id));
    select * into v_reward from private.rewards r where r.id = p_reward_id for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_reward.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_reward.archived_at is not null then
      return query select 'archived', null::jsonb, v_reward.revision;
      return;
    end if;
    if v_reward.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_reward.revision;
      return;
    end if;
    v_used := private.reward_total_used(v_reward.id);
    v_impact := pg_catalog.jsonb_build_object(
      'pending', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'pending'),
      'redeemed', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'redeemed'),
      'costChanged', p_cost <> v_reward.cost,
      'totalReached', p_total_limit is not null and v_used >= p_total_limit,
      'approvalChanged', p_requires_approval <> v_reward.requires_approval);
    if p_dry_run then
      return query select 'preview', v_impact, v_reward.revision;
      return;
    end if;
    update private.rewards r
      set name = p_name, description = v_description, cost = p_cost,
        requires_approval = p_requires_approval, enabled = p_enabled, available_from = p_available_from,
        available_until = p_available_until, total_limit = p_total_limit, member_limit = p_member_limit,
        member_period = p_member_period, revision = r.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where r.id = v_reward.id
      returning * into v_reward;
    perform private.audit('rewards.updated', v_reward.home_id, 'reward', v_reward.id,
      pg_catalog.jsonb_build_object('cost', v_reward.cost, 'enabled', v_reward.enabled,
        'approval', v_reward.requires_approval));
    return query select 'saved', v_impact, v_reward.revision;
  end
  $$;

-- Archives a reward (it leaves the catalog; pending requests, outstanding fulfillment and history
-- stay) or brings it back (rewards managers). Outcomes: 'saved' (with impact: pending, outstanding),
-- 'unchanged', 'conflict', 'limit_reached', 'not_found', 'not_permitted'.
create function public.archive_reward(p_reward_id uuid, p_expected_revision integer, p_archived boolean)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reward private.rewards;
    v_impact jsonb;
  begin
    if p_reward_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_points_home((select r.home_id from private.rewards r where r.id = p_reward_id));
    select * into v_reward from private.rewards r where r.id = p_reward_id for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_reward.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_reward.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_reward.revision;
      return;
    end if;
    if (v_reward.archived_at is not null) = p_archived then
      return query select 'unchanged', null::jsonb, v_reward.revision;
      return;
    end if;
    if not p_archived then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rewards:' || v_reward.home_id::text, 0));
      if (select count(*) from private.rewards r where r.home_id = v_reward.home_id and r.archived_at is null)
         >= private.points_limit('rewards') then
        return query select 'limit_reached', null::jsonb, v_reward.revision;
        return;
      end if;
    end if;
    v_impact := pg_catalog.jsonb_build_object(
      'pending', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'pending'),
      'outstanding', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'redeemed' and r.fulfillment <> 'fulfilled'
          and (r.resolution is null or r.replacement_status in ('pending', 'unable'))));
    update private.rewards r
      set archived_at = case when p_archived then pg_catalog.now() end,
        archived_by = case when p_archived then v_user_id end,
        revision = r.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where r.id = v_reward.id
      returning * into v_reward;
    perform private.audit(case when p_archived then 'rewards.archived' else 'rewards.restored' end,
      v_reward.home_id, 'reward', v_reward.id, v_impact);
    return query select 'saved', v_impact, v_reward.revision;
  end
  $$;

-- Redemptions -------------------------------------------------------------------------------------------

create function private.redemption_event(p_redemption_id uuid, p_kind text, p_actor uuid, p_note text,
  p_details jsonb default '{}'::jsonb) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.reward_redemption_events (redemption_id, kind, actor_id, note, details)
    values (p_redemption_id, p_kind, p_actor, p_note, p_details);
  $$;

-- Tells a redemption's requester what happened (category 'rewards'), once per event.
create function private.notify_requester(p_redemption private.reward_redemptions, p_kind text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_redemption.requested_by is null then
      return;
    end if;
    perform private.notify_user(p_redemption.requested_by, p_redemption.home_id, 'rewards', p_kind,
      pg_catalog.jsonb_build_object('homeId', p_redemption.home_id, 'redemptionId', p_redemption.id),
      p_kind || ':' || p_redemption.id::text || ':'
        || (select max(e.id) from private.reward_redemption_events e where e.redemption_id = p_redemption.id)::text,
      true);
  end
  $$;

-- Whether anyone other than the requester could approve the request now.
create function private.reward_reviewer_available(p_home_id uuid, p_requester uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id is distinct from p_requester
      and private.can_approve_rewards(p_home_id, m.user_id));
  $$;

-- Redeems a reward immediately, or requests an approval-required one (any current member, for
-- themselves; spec "Confirmed optional approval for reward redemption"). p_id comes from the client,
-- so a retry returns 'exists' with the redemption as it is. p_expected_cost is the cost the member
-- saw: a changed cost answers 'cost_changed' so they confirm the new one. Everything is checked
-- under the reward's lock, then the account's: availability, total and per-member capacity, and
-- available points. An immediate redemption deducts the cost once and enters Pending fulfillment;
-- a request reserves the cost and its capacity and tells the reviewers. p_dry_run returns the
-- preview: cost, available now and after, mode. Outcomes: 'preview', 'redeemed', 'requested',
-- 'exists', 'cost_changed', 'insufficient_points', 'archived', 'disabled', 'not_started', 'ended',
-- 'sold_out', 'member_limit' (with nextEligibleOn), 'not_found'.
create function public.redeem_reward(
  p_id uuid, p_reward_id uuid, p_expected_cost integer, p_dry_run boolean default false
) returns table (outcome text, detail jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reward private.rewards;
    v_existing private.reward_redemptions;
    v_account private.point_accounts;
    v_today date;
    v_block text;
    v_detail jsonb;
    v_redemption private.reward_redemptions;
    v_reviewer uuid;
  begin
    if p_id is null or p_reward_id is null or p_expected_cost is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_points_home((select r.home_id from private.rewards r where r.id = p_reward_id));
    select * into v_reward from private.rewards r where r.id = p_reward_id for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    select * into v_existing from private.reward_redemptions r where r.id = p_id;
    if found then
      if v_existing.requested_by is distinct from v_user_id or v_existing.reward_id <> p_reward_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', pg_catalog.jsonb_build_object('id', v_existing.id, 'status', v_existing.status);
      return;
    end if;
    v_account := private.lock_point_account(v_reward.home_id, v_user_id);
    v_today := private.task_today(v_reward.home_id, null);
    v_block := private.reward_block(v_reward, v_account.id, v_today);
    if v_block is not null then
      return query select v_block, case when v_block = 'member_limit' then pg_catalog.jsonb_build_object(
        'nextEligibleOn', private.reward_period_next(v_reward.home_id, v_reward.member_period, v_today)) end;
      return;
    end if;
    v_detail := pg_catalog.jsonb_build_object('cost', v_reward.cost, 'requiresApproval', v_reward.requires_approval,
      'available', v_account.balance - v_account.reserved,
      'availableAfter', v_account.balance - v_account.reserved - v_reward.cost,
      'reviewerAvailable', not v_reward.requires_approval
        or private.reward_reviewer_available(v_reward.home_id, v_user_id));
    if v_reward.cost <> p_expected_cost then
      return query select 'cost_changed', v_detail;
      return;
    end if;
    if v_account.balance - v_account.reserved < v_reward.cost then
      return query select 'insufficient_points', v_detail;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_detail;
      return;
    end if;
    insert into private.reward_redemptions (
      id, home_id, reward_id, account_id, requested_by, cost, reward_name, status, redeemed_at,
      fulfillment, decided_at
    ) values (
      p_id, v_reward.home_id, v_reward.id, v_account.id, v_user_id, v_reward.cost, v_reward.name,
      case when v_reward.requires_approval then 'pending' else 'redeemed' end,
      case when v_reward.requires_approval then null else pg_catalog.now() end,
      case when v_reward.requires_approval then null else 'pending' end,
      case when v_reward.requires_approval then null else pg_catalog.now() end
    ) returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'requested', v_user_id, null);
    if v_reward.requires_approval then
      perform private.change_reserved(v_account.id, v_reward.cost);
      for v_reviewer in
        select m.user_id from public.home_memberships m
        where m.home_id = v_reward.home_id and m.user_id <> v_user_id
          and private.can_approve_rewards(v_reward.home_id, m.user_id)
        order by m.user_id
      loop
        perform private.notify_user(v_reviewer, v_reward.home_id, 'rewards', 'reward.requested',
          pg_catalog.jsonb_build_object('homeId', v_reward.home_id, 'redemptionId', v_redemption.id),
          'reward.requested:' || v_redemption.id::text, true);
      end loop;
    else
      perform private.post_point_entry(v_account.id, 'redemption', -v_reward.cost, null, null,
        v_redemption.id, null, null, v_user_id, null);
      perform private.redemption_event(v_redemption.id, 'redeemed', v_user_id, null);
    end if;
    perform private.audit(case when v_reward.requires_approval then 'rewards.requested' else 'rewards.redeemed' end,
      v_reward.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('reward', v_reward.id, 'cost', v_reward.cost));
    return query select case when v_reward.requires_approval then 'requested' else 'redeemed' end,
      v_detail || pg_catalog.jsonb_build_object('id', v_redemption.id);
  end
  $$;

-- A redemption locked for a change: its reward first, then the row. Null when missing or not in a
-- Home the caller belongs to.
create function private.lock_redemption(p_redemption_id uuid, p_user_id uuid) returns private.reward_redemptions
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_redemption private.reward_redemptions;
  begin
    perform private.lock_points_home(
      (select r.home_id from private.reward_redemptions r where r.id = p_redemption_id));
    perform 1 from private.rewards w
      where w.id = (select r.reward_id from private.reward_redemptions r where r.id = p_redemption_id)
      for update;
    select * into v_redemption from private.reward_redemptions r where r.id = p_redemption_id for update;
    if not found or not private.is_home_member(v_redemption.home_id, p_user_id) then
      return null;
    end if;
    return v_redemption;
  end
  $$;

-- Approves or rejects someone else's pending request (approveHomeRewards; spec "Confirmed independent
-- reviewer for reward redemptions": never the requester, whatever their role). Approval needs the
-- requester to be a current member; a reward archived, disabled or outside its window since the
-- request needs p_confirm ('reward_unavailable' otherwise, with the reason). Approval turns the
-- reservation into one redemption entry and starts fulfillment; rejection (optional reason)
-- releases it. Outcomes: 'approved', 'rejected', 'own_request', 'not_pending', 'conflict',
-- 'reward_unavailable', 'requester_unavailable', 'not_found', 'not_permitted'.
create function public.review_reward_redemption(
  p_redemption_id uuid, p_expected_revision integer, p_decision text, p_reason text default null,
  p_confirm boolean default false
) returns table (outcome text, detail jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_redemption private.reward_redemptions;
    v_reward private.rewards;
    v_block text;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_decision is null
       or p_decision not in ('approve', 'reject') or p_confirm is null
       or (p_decision = 'approve' and v_reason is not null)
       or (v_reason is not null and not private.is_plain_text(v_reason, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_approve_rewards(v_redemption.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_redemption.requested_by = v_user_id then
      return query select 'own_request', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.status <> 'pending' then
      return query select 'not_pending', pg_catalog.jsonb_build_object('status', v_redemption.status),
        v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_redemption.revision;
      return;
    end if;
    perform 1 from private.point_accounts a where a.id = v_redemption.account_id for update;
    if p_decision = 'approve' then
      if v_redemption.requested_by is null
         or not private.is_home_member(v_redemption.home_id, v_redemption.requested_by) then
        return query select 'requester_unavailable', null::jsonb, v_redemption.revision;
        return;
      end if;
      select * into v_reward from private.rewards w where w.id = v_redemption.reward_id;
      v_block := case
        when v_reward.archived_at is not null then 'archived'
        when not v_reward.enabled then 'disabled'
        when v_reward.available_until is not null
          and private.task_today(v_reward.home_id, null) > v_reward.available_until then 'ended'
      end;
      if v_block is not null and not p_confirm then
        return query select 'reward_unavailable', pg_catalog.jsonb_build_object('reason', v_block),
          v_redemption.revision;
        return;
      end if;
      perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
      perform private.post_point_entry(v_redemption.account_id, 'redemption', -v_redemption.cost,
        null, null, v_redemption.id, null, null, v_user_id, null);
      update private.reward_redemptions r
        set status = 'redeemed', decided_at = pg_catalog.now(), decided_by = v_user_id,
          redeemed_at = pg_catalog.now(), fulfillment = 'pending', revision = r.revision + 1
        where r.id = v_redemption.id
        returning * into v_redemption;
      perform private.redemption_event(v_redemption.id, 'approved', v_user_id, null,
        case when v_block is not null then pg_catalog.jsonb_build_object('confirmedUnavailable', v_block)
          else '{}'::jsonb end);
      perform private.notify_requester(v_redemption, 'reward.approved');
      perform private.audit('rewards.approved', v_redemption.home_id, 'reward_redemption', v_redemption.id,
        pg_catalog.jsonb_build_object('cost', v_redemption.cost));
      return query select 'approved', null::jsonb, v_redemption.revision;
      return;
    end if;
    perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
    update private.reward_redemptions r
      set status = 'rejected', decided_at = pg_catalog.now(), decided_by = v_user_id,
        decision_reason = v_reason, revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'rejected', v_user_id, v_reason);
    perform private.notify_requester(v_redemption, 'reward.rejected');
    perform private.audit('rewards.rejected', v_redemption.home_id, 'reward_redemption', v_redemption.id);
    return query select 'rejected', null::jsonb, v_redemption.revision;
  end
  $$;

-- Cancels a pending request (spec "Confirmed cancellation of pending reward redemptions"): the
-- requester their own (no reason needed), or a rewards manager anyone's with a reason (3-300; the
-- requester is told). Releases the reservation once. Outcomes: 'cancelled', 'not_pending',
-- 'conflict', 'reason_required', 'not_found', 'not_permitted'.
create function public.cancel_reward_redemption(
  p_redemption_id uuid, p_expected_revision integer, p_reason text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_redemption private.reward_redemptions;
    v_own boolean;
  begin
    if p_redemption_id is null or p_expected_revision is null
       or (v_reason is not null and not private.is_plain_text(v_reason, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    v_own := v_redemption.requested_by = v_user_id;
    if not v_own and not private.can_manage_rewards(v_redemption.home_id, v_user_id) then
      return query select case when private.can_approve_rewards(v_redemption.home_id, v_user_id)
        then 'not_permitted' else 'not_found' end, null::integer;
      return;
    end if;
    if v_redemption.status <> 'pending' then
      return query select 'not_pending', v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', v_redemption.revision;
      return;
    end if;
    if not v_own and (v_reason is null or pg_catalog.char_length(v_reason) < private.points_limit('reason_min')) then
      return query select 'reason_required', v_redemption.revision;
      return;
    end if;
    perform 1 from private.point_accounts a where a.id = v_redemption.account_id for update;
    perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
    update private.reward_redemptions r
      set status = 'cancelled', decided_at = pg_catalog.now(), decided_by = v_user_id,
        decision_reason = case when v_own then null else v_reason end, revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'cancelled', v_user_id,
      case when v_own then null else v_reason end, pg_catalog.jsonb_build_object('own', v_own));
    if not v_own then
      perform private.notify_requester(v_redemption, 'reward.cancelled');
    end if;
    perform private.audit('rewards.cancelled', v_redemption.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('own', v_own));
    return query select 'cancelled', v_redemption.revision;
  end
  $$;

-- Sets the fulfillment of a redeemed reward (rewards managers; spec "Confirmed reward fulfillment
-- tracking"): 'fulfilled' or 'unable' from Pending, with an optional note; a correction of a
-- mistaken state (back to 'pending', or between the two) needs a reason and is only possible before
-- an Unable-to-fulfill case is resolved. Points never move here. Outcomes: 'saved', 'unchanged',
-- 'reason_required', 'resolved', 'not_redeemed', 'conflict', 'not_found', 'not_permitted'.
create function public.set_reward_fulfillment(
  p_redemption_id uuid, p_expected_revision integer, p_state text, p_note text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_redemption private.reward_redemptions;
    v_before text;
    v_correction boolean;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_state is null
       or p_state not in ('pending', 'fulfilled', 'unable')
       or (v_note is not null and not private.is_plain_text(v_note, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_redemption.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_redemption.status <> 'redeemed' then
      return query select 'not_redeemed', v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', v_redemption.revision;
      return;
    end if;
    if v_redemption.fulfillment = p_state then
      return query select 'unchanged', v_redemption.revision;
      return;
    end if;
    if v_redemption.resolution is not null then
      return query select 'resolved', v_redemption.revision;
      return;
    end if;
    v_before := v_redemption.fulfillment;
    v_correction := v_before <> 'pending';
    if v_correction and (v_note is null or pg_catalog.char_length(v_note) < private.points_limit('reason_min')) then
      return query select 'reason_required', v_redemption.revision;
      return;
    end if;
    update private.reward_redemptions r
      set fulfillment = p_state, fulfillment_at = pg_catalog.now(), fulfillment_by = v_user_id,
        fulfillment_note = v_note, revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id,
      case when v_correction then 'fulfillment_corrected' else p_state end, v_user_id, v_note,
      pg_catalog.jsonb_build_object('from', v_before, 'to', p_state));
    if p_state in ('fulfilled', 'unable') then
      perform private.notify_requester(v_redemption,
        case p_state when 'fulfilled' then 'reward.fulfilled' else 'reward.unable' end);
    end if;
    perform private.audit('rewards.fulfillment', v_redemption.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('from', v_before, 'to', p_state));
    return query select 'saved', v_redemption.revision;
  end
  $$;

-- Resolves an Unable-to-fulfill reward (rewards managers; spec "Confirmed unable-to-fulfill reward
-- resolution"), also after a replacement could not be fulfilled: 'refund' credits the original cost
-- back to the original account once (a linked entry; the account's holder need not still be a
-- member: the points stay in the preserved ledger), 'replacement' records what was agreed
-- (p_replacement, 1-200) and who is responsible (p_responsible, a current member's membership id),
-- never charging again. Optional note. p_dry_run returns the impact. Outcomes: 'preview', 'resolved',
-- 'not_unable', 'already_resolved', 'account_unavailable', 'invalid_responsible', 'conflict',
-- 'not_found', 'not_permitted'.
create function public.resolve_reward_redemption(
  p_redemption_id uuid, p_expected_revision integer, p_resolution text, p_note text default null,
  p_replacement text default null, p_responsible uuid default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_replacement text := private.chore_short_text(p_replacement);
    v_redemption private.reward_redemptions;
    v_account private.point_accounts;
    v_responsible uuid;
    v_impact jsonb;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_dry_run is null
       or p_resolution is null or p_resolution not in ('refund', 'replacement')
       or (v_note is not null and not private.is_plain_text(v_note, private.points_limit('reason')))
       or (p_resolution = 'replacement' and (v_replacement is null or p_responsible is null
         or not private.is_plain_text(v_replacement, private.points_limit('replacement'))))
       or (p_resolution = 'refund' and (p_replacement is not null or p_responsible is not null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_redemption.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_redemption.status <> 'redeemed' or v_redemption.fulfillment <> 'unable' then
      return query select 'not_unable', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.resolution = 'refund'
       or (v_redemption.resolution = 'replacement' and v_redemption.replacement_status <> 'unable') then
      return query select 'already_resolved', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_redemption.revision;
      return;
    end if;
    select * into v_account from private.point_accounts a where a.id = v_redemption.account_id for update;
    if p_resolution = 'refund' and v_account.user_id is null then
      return query select 'account_unavailable', null::jsonb, v_redemption.revision;
      return;
    end if;
    if p_resolution = 'replacement' then
      select m.user_id into v_responsible from public.home_memberships m
        where m.home_id = v_redemption.home_id and m.id = p_responsible;
      if v_responsible is null then
        return query select 'invalid_responsible', null::jsonb, v_redemption.revision;
        return;
      end if;
    end if;
    v_impact := pg_catalog.jsonb_build_object('resolution', p_resolution, 'cost', v_redemption.cost,
      'person', private.chore_person(v_redemption.home_id, v_account.user_id, v_user_id),
      'availableAfter', case when p_resolution = 'refund' and private.can_manage_points(v_redemption.home_id, v_user_id)
        then v_account.balance - v_account.reserved + v_redemption.cost end);
    if p_dry_run then
      return query select 'preview', v_impact, v_redemption.revision;
      return;
    end if;
    if p_resolution = 'refund' then
      perform private.post_point_entry(v_account.id, 'refund', v_redemption.cost, null, null,
        v_redemption.id, null, v_note, v_user_id, null);
    end if;
    update private.reward_redemptions r
      set resolution = p_resolution, resolved_at = pg_catalog.now(), resolved_by = v_user_id,
        resolution_note = v_note,
        replacement = case when p_resolution = 'replacement' then v_replacement end,
        replacement_responsible = case when p_resolution = 'replacement' then v_responsible end,
        replacement_status = case when p_resolution = 'replacement' then 'pending' end,
        revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id,
      case p_resolution when 'refund' then 'refunded' else 'replacement' end, v_user_id, v_note,
      case when p_resolution = 'replacement' then pg_catalog.jsonb_build_object('replacement', v_replacement)
        else pg_catalog.jsonb_build_object('amount', v_redemption.cost) end);
    perform private.notify_requester(v_redemption,
      case p_resolution when 'refund' then 'reward.refunded' else 'reward.replacement' end);
    perform private.audit('rewards.resolved', v_redemption.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('resolution', p_resolution));
    return query select 'resolved', v_impact, v_redemption.revision;
  end
  $$;

-- Records a replacement's outcome (rewards managers): 'fulfilled' or 'unable' (the case can then be
-- resolved again). Outcomes: 'saved', 'not_replacement', 'conflict', 'not_found', 'not_permitted'.
create function public.set_replacement_outcome(
  p_redemption_id uuid, p_expected_revision integer, p_state text, p_note text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_redemption private.reward_redemptions;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_state is null
       or p_state not in ('fulfilled', 'unable')
       or (v_note is not null and not private.is_plain_text(v_note, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_redemption.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_redemption.resolution is distinct from 'replacement' or v_redemption.replacement_status <> 'pending' then
      return query select 'not_replacement', v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', v_redemption.revision;
      return;
    end if;
    update private.reward_redemptions r
      set replacement_status = p_state, revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'replacement_' || p_state, v_user_id, v_note);
    perform private.notify_requester(v_redemption,
      case p_state when 'fulfilled' then 'reward.fulfilled' else 'reward.unable' end);
    perform private.audit('rewards.replacement', v_redemption.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('state', p_state));
    return query select 'saved', v_redemption.revision;
  end
  $$;

-- A redemption as p_viewer sees it, with what they may do.
create function private.redemption_json(p_redemption private.reward_redemptions, p_viewer uuid,
  p_events boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_manage boolean := private.can_manage_rewards(p_redemption.home_id, p_viewer);
    v_approve boolean := private.can_approve_rewards(p_redemption.home_id, p_viewer);
    v_own boolean := p_redemption.requested_by = p_viewer;
    v_open_unable boolean := p_redemption.status = 'redeemed' and p_redemption.fulfillment = 'unable'
      and (p_redemption.resolution is null
        or (p_redemption.resolution = 'replacement' and p_redemption.replacement_status = 'unable'));
  begin
    return pg_catalog.jsonb_build_object(
      'id', p_redemption.id, 'rewardId', p_redemption.reward_id, 'rewardName', p_redemption.reward_name,
      'cost', p_redemption.cost, 'status', p_redemption.status,
      'requester', private.chore_person(p_redemption.home_id, p_redemption.requested_by, p_viewer),
      'requestedAt', p_redemption.requested_at, 'decidedAt', p_redemption.decided_at,
      'decidedBy', private.chore_person(p_redemption.home_id, p_redemption.decided_by, p_viewer),
      'decisionReason', p_redemption.decision_reason, 'departed', p_redemption.departed,
      'redeemedAt', p_redemption.redeemed_at, 'fulfillment', p_redemption.fulfillment,
      'fulfillmentAt', p_redemption.fulfillment_at,
      'fulfillmentBy', private.chore_person(p_redemption.home_id, p_redemption.fulfillment_by, p_viewer),
      'fulfillmentNote', p_redemption.fulfillment_note,
      'resolution', p_redemption.resolution, 'resolvedAt', p_redemption.resolved_at,
      'resolutionNote', p_redemption.resolution_note, 'replacement', p_redemption.replacement,
      'replacementResponsible', private.chore_person(p_redemption.home_id,
        p_redemption.replacement_responsible, p_viewer),
      'replacementStatus', p_redemption.replacement_status, 'revision', p_redemption.revision,
      'canApprove', coalesce(p_redemption.status = 'pending' and v_approve and not v_own, false),
      'canCancel', coalesce(p_redemption.status = 'pending' and (v_own or v_manage), false),
      'canFulfil', coalesce(p_redemption.status = 'redeemed' and v_manage
        and p_redemption.resolution is null, false),
      'canResolve', coalesce(v_manage and v_open_unable, false),
      'canSetReplacement', coalesce(v_manage and p_redemption.resolution = 'replacement'
        and p_redemption.replacement_status = 'pending', false),
      'blocker', case when p_redemption.status = 'pending' then case
        when v_own and v_approve then 'own_request'
        when not private.reward_reviewer_available(p_redemption.home_id, p_redemption.requested_by)
          then 'no_reviewer' end end,
      'events', case when p_events then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind', e.kind, 'at', e.created_at, 'note', e.note, 'details', e.details,
          'actor', private.chore_person(p_redemption.home_id, e.actor_id, p_viewer)) order by e.id)
        from private.reward_redemption_events e where e.redemption_id = p_redemption.id), '[]'::jsonb) end);
  end
  $$;

-- Whether p_viewer may see a redemption: its requester, rewards managers, and reviewers while it is
-- pending.
create function private.can_see_redemption(p_redemption private.reward_redemptions, p_viewer uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.is_home_member(p_redemption.home_id, p_viewer) and (
    p_redemption.requested_by = p_viewer
    or private.can_manage_rewards(p_redemption.home_id, p_viewer)
    or (p_redemption.status = 'pending' and private.can_approve_rewards(p_redemption.home_id, p_viewer)));
  $$;

-- Redemptions of one Home by view: 'mine' (the caller's own), 'approvals' (pending, reviewers),
-- 'fulfillment' (redeemed and not settled: pending fulfillment, unresolved Unable to fulfill, a
-- replacement pending or unable; rewards managers), 'all' (rewards managers). Newest first, at most
-- 100. 42501 for a Home the caller is not in.
create function public.list_reward_redemptions(p_home_id uuid, p_view text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_view is null or p_view not in ('mine', 'approvals', 'fulfillment', 'all') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if (p_view = 'approvals' and not private.can_approve_rewards(p_home_id, v_user_id))
       or (p_view in ('fulfillment', 'all') and not private.can_manage_rewards(p_home_id, v_user_id)) then
      return '[]'::jsonb;
    end if;
    return coalesce((select pg_catalog.jsonb_agg(private.redemption_json(r, v_user_id) order by r.seq desc)
      from (
        select * from private.reward_redemptions r
        where r.home_id = p_home_id and case p_view
          when 'mine' then r.requested_by = v_user_id
          when 'approvals' then r.status = 'pending'
          when 'fulfillment' then r.status = 'redeemed' and (r.fulfillment = 'pending'
            or (r.fulfillment = 'unable' and (r.resolution is null
              or (r.resolution = 'replacement' and r.replacement_status in ('pending', 'unable')))))
          else true end
        order by r.seq desc limit private.points_limit('redemptions_page')
      ) r), '[]'::jsonb);
  end
  $$;

-- One redemption with its history, or null when the caller may not see it.
create function public.get_reward_redemption(p_redemption_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_redemption private.reward_redemptions;
  begin
    if p_redemption_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_redemption from private.reward_redemptions r where r.id = p_redemption_id;
    if not found or not private.can_see_redemption(v_redemption, v_user_id) then
      return null;
    end if;
    return private.redemption_json(v_redemption, v_user_id, true);
  end
  $$;

-- Departure -------------------------------------------------------------------------------------------------

-- Leaving or being removed (spec "Confirmed Home reward points on membership departure"): pending
-- requests are cancelled and their reservations released once (each under its reward's lock, then
-- its own, then the account's, like every other change); the account, its balance and history stay
-- for a rejoin with the same account. Fulfillment obligations stay with the rewards managers.
create function private.points_member_left() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_redemption private.reward_redemptions;
  begin
    for v_id in
      select r.id from private.reward_redemptions r
      join private.point_accounts a on a.id = r.account_id
      where a.home_id = old.home_id and a.user_id = old.user_id and r.status = 'pending'
      order by r.seq
    loop
      perform 1 from private.rewards w
        where w.id = (select r.reward_id from private.reward_redemptions r where r.id = v_id) for update;
      select * into v_redemption from private.reward_redemptions r where r.id = v_id for update;
      if v_redemption.status <> 'pending' then
        continue;
      end if;
      perform 1 from private.point_accounts a where a.id = v_redemption.account_id for update;
      perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
      update private.reward_redemptions r
        set status = 'cancelled', decided_at = pg_catalog.now(), departed = true, revision = r.revision + 1
        where r.id = v_id;
      perform private.redemption_event(v_id, 'cancelled', null, null,
        pg_catalog.jsonb_build_object('departed', true));
    end loop;
    return old;
  end
  $$;

create trigger home_memberships_points before delete on public.home_memberships
  for each row execute function private.points_member_left();

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_notification_settings', 'create_chore', 'update_chore', 'create_chore_template',
      'update_chore_template', 'list_chore_templates', 'reopen_chore_occurrence',
      'correct_chore_completion', 'preview_chore_points_change', 'set_chore_occurrence_points',
      'get_chore_points', 'list_chore_points', 'get_point_summary', 'list_point_entries',
      'list_point_accounts', 'adjust_points', 'reverse_point_entry', 'update_point_preferences',
      'update_point_settings', 'get_point_leaderboard', 'get_weekly_points', 'list_rewards',
      'create_reward', 'update_reward', 'archive_reward', 'redeem_reward', 'review_reward_redemption',
      'cancel_reward_redemption', 'set_reward_fulfillment', 'resolve_reward_redemption',
      'set_replacement_outcome', 'list_reward_redemptions', 'get_reward_redemption'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like '%chore%' or p.proname like '%point%'
      or p.proname like '%reward%' or p.proname like '%redemption%' or p.proname = 'change_reserved'
      or p.proname = 'notify_requester')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
