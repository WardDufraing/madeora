-- S28b: personal points and rewards (brief plans/steps/S28b-brief.md; ADR 0036; spec "Rewards and
-- points" in both contexts, PS L2495-L2502; Personal context belongs to the individual, PS L55-L56,
-- L91, L94-L100). Ward decided the boundary on 2026-10-28: personal points are strictly personal, one
-- ledger per account, independent of every Home; personal rewards are self-defined only.
--
-- A second ledger, beside the Home ledger of S23 and sharing nothing with it: these tables have no
-- home_id, no row of point_accounts, point_entries, rewards or reward_redemptions is ever written
-- here, no function moves points between the two, and no Home role, capability, staff function or
-- other account can read or change it. Deleting or leaving a Home does nothing to it.
--
-- Nothing is exposed as a table. Every read and write is a security-definer function that takes the
-- owner from auth.uid() (a confirmed caller) and touches only that owner's rows: every lookup is by
-- (user_id, id) with user_id the caller, so another person's row answers exactly like a missing one,
-- and every primary key starts with user_id, so an id another account uses never collides with the
-- caller's (a retry can never learn that someone else holds an id). No policy or function lets a
-- Home owner, an administrator, staff or a display through; the API uses the caller's session.
--
-- The ledger. private.personal_point_entries is append-only (an update is refused; rows go only
-- with the account): credits and corrections the owner posts with a reason, one reversal of a credit
-- or correction, immediate redemptions and one refund per Unable-to-fulfill redemption. The account
-- caches its balance (the sum of its entries, checked never below zero); available = balance, since
-- redemptions are immediate and nothing is reserved. Earned = credits, corrections and reversals;
-- spent = redemptions less refunds. Nothing posts automatically: no trigger on chores, tasks, habits
-- or goals (MOD L70; PS L2957, L2966, L2984). Points never expire (default, after PS L1452-L1456).
--
-- Rewards are the owner's own: name, description, cost, enabled, an optional availability window, an
-- optional total limit and an optional limit per week, month, year or ever. Dates are local calendar
-- dates of the owner's effective timezone, which the app knows (the account's chosen zone or the
-- device's), so it passes "today" (accepted within a day of the UTC date, like personal tasks) and
-- the effective week start; a redemption keeps the local date it was made on, so period limits
-- never depend on a zone stored here. Redemption is immediate; fulfillment is Pending, Fulfilled or
-- Unable to fulfill, recorded by the owner; Unable is resolved once by a refund (one linked entry)
-- or a replacement (the owner's note, never charged again).
--
-- Lock order: every change locks the owner's account row first (created when missing), then the
-- reward, then the redemption. Nothing here locks a Home row or a Home point account.
--
-- Not audited in private.audit_events (Home-scoped and readable by Home tooling), like personal
-- habits: the append-only ledger and the redemption events, each with its actor, are the record.
--
-- Notifications: none. Every change is the owner's own, and Madeora never tells the person who made
-- a change about it (S23 adjustments, S28 pauses); a later rule that posts points for the owner would
-- add its notice with that rule.
--
-- Personal data: every row here is personally owned and keyed by user_id alone, so the later
-- personal export and account-deletion steps select it by user id (PS L657-L672, L717). user_id
-- references auth.users on delete cascade, so the ledger lives exactly as long as the auth user; if
-- account deletion removes the auth user at the start of the 30-day recovery period rather than at
-- its end (architecture.md §36), that step must keep these rows until final deletion. Nothing here
-- erases Home-owned content (PS L718).

-- Limits ---------------------------------------------------------------------------------------------------

-- The same numbers as S23's private.points_limit and packages/domain POINTS_LIMITS.
create function private.personal_points_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'adjustment' then 100000      -- largest credit or correction
    when 'cost' then 100000            -- largest reward cost
    when 'reason' then 300             -- reasons and notes
    when 'reason_min' then 3           -- a meaningful reason
    when 'reward_name' then 80
    when 'reward_description' then 500
    when 'replacement' then 200
    when 'total_limit' then 10000
    when 'period_limit' then 100
    when 'rewards' then 200            -- active (not archived) rewards per account
    when 'page' then 50                -- ledger entries one read returns
    when 'redemptions_page' then 100
  end;
  $$;

-- Tables ---------------------------------------------------------------------------------------------------

-- One account's personal points.
create table private.personal_point_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- The sum of the account's entries; nothing ever takes it below zero.
  balance integer not null default 0 constraint personal_point_accounts_balance_check check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.personal_rewards (
  user_id uuid not null references private.personal_point_accounts (user_id) on delete cascade,
  id uuid not null,
  name text not null constraint personal_rewards_name_check check (private.is_visible_name(name, 80)),
  description text constraint personal_rewards_description_check
    check (description is null or private.is_plain_text(description, 500)),
  cost integer not null constraint personal_rewards_cost_check check (cost between 1 and 100000),
  enabled boolean not null default true,
  -- Inclusive first and last local day it can be redeemed (null: open-ended).
  available_from date,
  available_until date,
  -- At most this many redemptions in total (null: unlimited).
  total_limit integer constraint personal_rewards_total_limit_check check (total_limit between 1 and 10000),
  -- At most period_limit redemptions per limit_period (null: unlimited).
  period_limit integer constraint personal_rewards_period_limit_check check (period_limit between 1 and 100),
  limit_period text constraint personal_rewards_limit_period_check
    check (limit_period in ('week', 'month', 'year', 'ever')),
  archived_at timestamptz,
  revision integer not null default 1 constraint personal_rewards_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint personal_rewards_window_check check (
    available_from is null or available_until is null or available_until >= available_from),
  constraint personal_rewards_period_check check ((period_limit is null) = (limit_period is null))
);

create index personal_rewards_active_idx on private.personal_rewards (user_id) where archived_at is null;

-- One redemption. Never deleted; its events are append-only.
create table private.personal_reward_redemptions (
  user_id uuid not null references private.personal_point_accounts (user_id) on delete cascade,
  id uuid not null,
  -- Order of redeeming, counted per account (never a shared counter, which would show other
  -- accounts' activity); assigned under the account lock.
  seq bigint not null constraint personal_reward_redemptions_seq_check check (seq >= 1),
  reward_id uuid not null,
  -- What it cost and was called when redeemed (a later edit never changes it).
  cost integer not null constraint personal_reward_redemptions_cost_check check (cost between 1 and 100000),
  reward_name text not null,
  redeemed_at timestamptz not null default now(),
  -- The owner's local date when redeemed (period limits count by it).
  redeemed_on date not null,
  fulfillment text not null default 'pending' constraint personal_reward_redemptions_fulfillment_check
    check (fulfillment in ('pending', 'fulfilled', 'unable')),
  fulfillment_at timestamptz,
  fulfillment_note text,
  -- How an Unable-to-fulfill reward was resolved; final.
  resolution text constraint personal_reward_redemptions_resolution_check
    check (resolution in ('refund', 'replacement')),
  resolved_at timestamptz,
  resolution_note text,
  replacement text,
  revision integer not null default 1
    constraint personal_reward_redemptions_revision_check check (revision >= 1),
  primary key (user_id, id),
  foreign key (user_id, reward_id) references private.personal_rewards (user_id, id) on delete cascade,
  constraint personal_reward_redemptions_state_check check (
    (resolution is null or fulfillment = 'unable')
    and (resolution is null) = (resolved_at is null)
    and (resolution = 'replacement') = (replacement is not null))
);

create index personal_reward_redemptions_reward_idx
  on private.personal_reward_redemptions (user_id, reward_id, redeemed_on);
create unique index personal_reward_redemptions_seq_idx on private.personal_reward_redemptions (user_id, seq desc);

create table private.personal_point_entries (
  user_id uuid not null references private.personal_point_accounts (user_id) on delete cascade,
  id uuid not null,
  -- Order of posting, counted per account (never a shared counter, which would show other
  -- accounts' activity); assigned under the account lock.
  seq bigint not null constraint personal_point_entries_seq_check check (seq >= 1),
  kind text not null constraint personal_point_entries_kind_check check (kind in (
    'credit', 'correction', 'manual_reversal', 'redemption', 'refund')),
  amount integer not null constraint personal_point_entries_amount_check check (amount <> 0),
  -- When the points count: the posting time, the original's for a reversal.
  attributed_at timestamptz not null,
  redemption_id uuid,
  reverses_id uuid,
  reason text,
  -- Always the owner (the only person who may change the ledger).
  actor_id uuid not null,
  available_before integer not null,
  available_after integer not null constraint personal_point_entries_after_check check (available_after >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, redemption_id)
    references private.personal_reward_redemptions (user_id, id) on delete cascade,
  foreign key (user_id, reverses_id) references private.personal_point_entries (user_id, id) on delete cascade,
  constraint personal_point_entries_actor_check check (actor_id = user_id),
  constraint personal_point_entries_sign_check check (
    (kind in ('credit', 'refund') and amount > 0)
    or (kind = 'redemption' and amount < 0)
    or kind in ('correction', 'manual_reversal')),
  constraint personal_point_entries_links_check check (
    (kind = 'manual_reversal') = (reverses_id is not null)
    and (kind in ('redemption', 'refund')) = (redemption_id is not null)
    and (kind in ('credit', 'correction', 'manual_reversal')) = (reason is not null)),
  constraint personal_point_entries_math_check check (available_after = available_before + amount)
);

create unique index personal_point_entries_seq_idx on private.personal_point_entries (user_id, seq desc);
-- An entry is reversed at most once; a redemption is charged and refunded at most once.
create unique index personal_point_entries_one_reversal on private.personal_point_entries (user_id, reverses_id)
  where reverses_id is not null;
create unique index personal_point_entries_one_redemption
  on private.personal_point_entries (user_id, redemption_id) where kind = 'redemption';
create unique index personal_point_entries_one_refund
  on private.personal_point_entries (user_id, redemption_id) where kind = 'refund';

create table private.personal_reward_redemption_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  redemption_id uuid not null,
  kind text not null constraint personal_reward_redemption_events_kind_check check (kind in (
    'redeemed', 'fulfilled', 'unable', 'pending', 'fulfillment_corrected', 'refunded', 'replacement')),
  note text,
  -- fulfillment changes: the state before and after; refunded: the amount.
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, redemption_id)
    references private.personal_reward_redemptions (user_id, id) on delete cascade
);

create index personal_reward_redemption_events_redemption_idx
  on private.personal_reward_redemption_events (user_id, redemption_id, id);

comment on table private.personal_point_accounts is
  'S28b: one account''s personal points. Personally owned; in scope for personal export and account deletion (by user_id).';
comment on table private.personal_point_entries is
  'S28b: append-only personal points ledger. Personally owned; in scope for personal export and account deletion (by user_id).';
comment on table private.personal_rewards is
  'S28b: self-defined personal rewards. Personally owned; in scope for personal export and account deletion (by user_id).';
comment on table private.personal_reward_redemptions is
  'S28b: personal reward redemptions. Personally owned; in scope for personal export and account deletion (by user_id).';
comment on table private.personal_reward_redemption_events is
  'S28b: history of personal reward redemptions. Personally owned; in scope for personal export and account deletion (by user_id).';

-- The ledger and the history are append-only: a change is a new row, never an edit.
create function private.personal_points_append_only() returns trigger
  language plpgsql set search_path = '' as $$
  begin
    raise exception 'append-only' using errcode = '42501';
  end
  $$;

create trigger personal_point_entries_append_only before update on private.personal_point_entries
  for each row execute function private.personal_points_append_only();
create trigger personal_reward_redemption_events_append_only
  before update on private.personal_reward_redemption_events
  for each row execute function private.personal_points_append_only();

alter table private.personal_point_accounts enable row level security;
alter table private.personal_point_entries enable row level security;
alter table private.personal_rewards enable row level security;
alter table private.personal_reward_redemptions enable row level security;
alter table private.personal_reward_redemption_events enable row level security;

revoke all on private.personal_point_accounts, private.personal_point_entries, private.personal_rewards,
  private.personal_reward_redemptions, private.personal_reward_redemption_events
  from public, anon, authenticated;

-- Primitives -------------------------------------------------------------------------------------------------

-- The caller's account, created when missing, locked. Every change takes it first.
create function private.lock_personal_account(p_user_id uuid) returns private.personal_point_accounts
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_account private.personal_point_accounts;
  begin
    insert into private.personal_point_accounts (user_id) values (p_user_id) on conflict (user_id) do nothing;
    select * into v_account from private.personal_point_accounts a where a.user_id = p_user_id for update;
    return v_account;
  end
  $$;

-- Posts one entry to a locked account and moves its balance (the balance check refuses anything
-- below zero; callers check first and answer 'insufficient_points').
create function private.post_personal_entry(
  p_user_id uuid, p_id uuid, p_kind text, p_amount integer, p_attributed_at timestamptz,
  p_redemption_id uuid, p_reverses_id uuid, p_reason text
) returns private.personal_point_entries
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_account private.personal_point_accounts;
    v_entry private.personal_point_entries;
  begin
    update private.personal_point_accounts a set balance = a.balance + p_amount, updated_at = pg_catalog.now()
      where a.user_id = p_user_id
      returning * into v_account;
    insert into private.personal_point_entries (
      user_id, id, seq, kind, amount, attributed_at, redemption_id, reverses_id, reason, actor_id,
      available_before, available_after
    ) values (
      p_user_id, coalesce(p_id, gen_random_uuid()),
      coalesce((select max(e.seq) from private.personal_point_entries e where e.user_id = p_user_id), 0) + 1,
      p_kind, p_amount,
      coalesce(p_attributed_at, pg_catalog.now()), p_redemption_id, p_reverses_id, p_reason, p_user_id,
      v_account.balance - p_amount, v_account.balance
    ) returning * into v_entry;
    return v_entry;
  end
  $$;

-- A meaningful reason (3-300 characters after whitespace runs read as one), or null.
create function private.personal_reason(p_reason text) returns text
  language sql immutable set search_path = '' as $$
  select case when v.reason is not null
      and pg_catalog.char_length(v.reason) >= private.personal_points_limit('reason_min')
      and private.is_plain_text(v.reason, private.personal_points_limit('reason')) then v.reason end
  from (select private.chore_short_text(p_reason) as reason) v;
  $$;

-- The owner's "today": the app's local date, accepted within a day of the UTC date.
create function private.personal_today(p_today date) returns date
  language sql stable security definer set search_path = '' as $$
  select private.task_today(null, p_today);
  $$;

-- The first local day of the period that contains p_today (null for 'ever').
create function private.personal_period_start(p_period text, p_week_start text, p_today date) returns date
  language sql immutable set search_path = '' as $$
  select case p_period
    when 'week' then private.habit_week_of(coalesce(p_week_start, 'monday'), p_today)
    when 'month' then pg_catalog.date_trunc('month', p_today::timestamp)::date
    when 'year' then pg_catalog.date_trunc('year', p_today::timestamp)::date
  end;
  $$;

-- The first local day of the next period (null for 'ever').
create function private.personal_period_next(p_period text, p_week_start text, p_today date) returns date
  language sql immutable set search_path = '' as $$
  select case p_period
    when 'week' then private.habit_week_of(coalesce(p_week_start, 'monday'), p_today) + 7
    when 'month' then (pg_catalog.date_trunc('month', p_today::timestamp) + interval '1 month')::date
    when 'year' then (pg_catalog.date_trunc('year', p_today::timestamp) + interval '1 year')::date
  end;
  $$;

create function private.personal_reward_used(p_reward private.personal_rewards) returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.personal_reward_redemptions r
  where r.user_id = p_reward.user_id and r.reward_id = p_reward.id;
  $$;

create function private.personal_reward_period_used(
  p_reward private.personal_rewards, p_week_start text, p_today date
) returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.personal_reward_redemptions r
  where r.user_id = p_reward.user_id and r.reward_id = p_reward.id
    and (p_reward.limit_period = 'ever'
      or r.redeemed_on >= private.personal_period_start(p_reward.limit_period, p_week_start, p_today));
  $$;

-- Why the reward cannot be redeemed now, or null: 'archived', 'disabled', 'not_started', 'ended',
-- 'sold_out', 'period_limit'.
create function private.personal_reward_block(
  p_reward private.personal_rewards, p_week_start text, p_today date
) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_reward.archived_at is not null then 'archived'
    when not p_reward.enabled then 'disabled'
    when p_reward.available_from is not null and p_today < p_reward.available_from then 'not_started'
    when p_reward.available_until is not null and p_today > p_reward.available_until then 'ended'
    when p_reward.total_limit is not null and private.personal_reward_used(p_reward) >= p_reward.total_limit
      then 'sold_out'
    when p_reward.period_limit is not null
      and private.personal_reward_period_used(p_reward, p_week_start, p_today) >= p_reward.period_limit
      then 'period_limit'
  end;
  $$;

create function private.personal_week_start(p_week_start text) returns text
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_week_start is not null and p_week_start not in ('monday', 'saturday', 'sunday') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return coalesce(p_week_start, 'monday');
  end
  $$;

-- Totals of an account (zeros when it has none yet): available (= balance), earned, spent.
create function private.personal_totals(p_user_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'available', coalesce((select a.balance from private.personal_point_accounts a where a.user_id = p_user_id), 0),
    'earned', coalesce((select sum(e.amount) from private.personal_point_entries e where e.user_id = p_user_id
      and e.kind in ('credit', 'correction', 'manual_reversal')), 0),
    'spent', coalesce((select -sum(e.amount) from private.personal_point_entries e where e.user_id = p_user_id
      and e.kind in ('redemption', 'refund')), 0));
  $$;

-- Points ------------------------------------------------------------------------------------------------------

-- The caller's totals and one page of their ledger, newest first (p_before: a seq from the previous
-- page). Only ever the caller's own.
create function public.get_personal_points(p_before bigint default null, p_limit integer default 50)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_limit integer := least(greatest(coalesce(p_limit, 50), 1), private.personal_points_limit('page'));
  begin
    return (
      with page as (
        select e.* from private.personal_point_entries e
        where e.user_id = v_user_id and (p_before is null or e.seq < p_before)
        order by e.seq desc limit v_limit + 1
      )
      select pg_catalog.jsonb_build_object(
        'totals', private.personal_totals(v_user_id),
        'entries', coalesce((select pg_catalog.jsonb_agg(x.item order by x.seq desc) from (
          select p.seq, pg_catalog.jsonb_build_object(
            'id', p.id, 'seq', p.seq, 'kind', p.kind, 'amount', p.amount,
            'attributedAt', p.attributed_at, 'createdAt', p.created_at, 'reason', p.reason,
            'availableBefore', p.available_before, 'availableAfter', p.available_after,
            'redemption', case when p.redemption_id is not null then (
              select pg_catalog.jsonb_build_object('id', r.id, 'rewardName', r.reward_name)
              from private.personal_reward_redemptions r
              where r.user_id = v_user_id and r.id = p.redemption_id) end,
            'reverses', p.reverses_id,
            'reversed', exists (select 1 from private.personal_point_entries r
              where r.user_id = v_user_id and r.reverses_id = p.id),
            'canReverse', p.kind in ('credit', 'correction') and not exists (
              select 1 from private.personal_point_entries r where r.user_id = v_user_id and r.reverses_id = p.id)
          ) as item
          from page p order by p.seq desc limit v_limit
        ) x), '[]'::jsonb),
        'next', case when (select count(*) from page) > v_limit
          then (select min(q.seq) from (select p.seq from page p order by p.seq desc limit v_limit) q) end));
  end
  $$;

-- A credit (positive) or correction (either sign) to the caller's own points, with a meaningful
-- reason. p_id comes from the client, so a retry returns 'exists'. A debit never takes the balance
-- below zero ('insufficient_points', nothing applied). p_dry_run returns the preview. Outcomes:
-- 'preview', 'posted', 'exists', 'insufficient_points'.
create function public.adjust_personal_points(
  p_id uuid, p_kind text, p_amount integer, p_reason text, p_dry_run boolean default false
) returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.personal_reason(p_reason);
    v_account private.personal_point_accounts;
    v_preview jsonb;
    v_entry private.personal_point_entries;
  begin
    if p_id is null or p_kind is null or p_kind not in ('credit', 'correction')
       or p_amount is null or p_amount = 0 or abs(p_amount) > private.personal_points_limit('adjustment')
       or (p_kind = 'credit' and p_amount < 0) or p_dry_run is null or v_reason is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_account := private.lock_personal_account(v_user_id);
    if exists (select 1 from private.personal_point_entries e where e.user_id = v_user_id and e.id = p_id) then
      return query select 'exists', null::jsonb, p_id;
      return;
    end if;
    v_preview := pg_catalog.jsonb_build_object('kind', p_kind, 'amount', p_amount,
      'available', v_account.balance, 'availableAfter', v_account.balance + p_amount);
    if v_account.balance + p_amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_entry := private.post_personal_entry(v_user_id, p_id, p_kind, p_amount, null, null, null, v_reason);
    return query select 'posted', v_preview, v_entry.id;
  end
  $$;

-- Reverses one of the caller's credits or corrections with a linked entry, once, with a reason. The
-- reversal follows the same rule as a debit. Outcomes: 'preview', 'reversed', 'already_reversed',
-- 'not_reversible', 'insufficient_points', 'not_found' (also for anyone else's entry).
create function public.reverse_personal_point_entry(
  p_entry_id uuid, p_reason text, p_dry_run boolean default false
) returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.personal_reason(p_reason);
    v_account private.personal_point_accounts;
    v_original private.personal_point_entries;
    v_reversal private.personal_point_entries;
    v_preview jsonb;
  begin
    if p_entry_id is null or p_dry_run is null or v_reason is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_account := private.lock_personal_account(v_user_id);
    select * into v_original from private.personal_point_entries e
      where e.user_id = v_user_id and e.id = p_entry_id;
    if not found then
      return query select 'not_found', null::jsonb, null::uuid;
      return;
    end if;
    if v_original.kind not in ('credit', 'correction') then
      return query select 'not_reversible', null::jsonb, null::uuid;
      return;
    end if;
    select * into v_reversal from private.personal_point_entries e
      where e.user_id = v_user_id and e.reverses_id = v_original.id;
    if found then
      return query select 'already_reversed', null::jsonb, v_reversal.id;
      return;
    end if;
    v_preview := pg_catalog.jsonb_build_object('kind', 'manual_reversal', 'amount', -v_original.amount,
      'available', v_account.balance, 'availableAfter', v_account.balance - v_original.amount);
    if v_account.balance - v_original.amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_reversal := private.post_personal_entry(v_user_id, null, 'manual_reversal', -v_original.amount,
      v_original.attributed_at, null, v_original.id, v_reason);
    return query select 'reversed', v_preview, v_reversal.id;
  end
  $$;

-- Rewards -----------------------------------------------------------------------------------------------------

create function private.personal_reward_json(
  p_reward private.personal_rewards, p_week_start text, p_today date, p_available integer
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_block text := private.personal_reward_block(p_reward, p_week_start, p_today);
  begin
    return pg_catalog.jsonb_build_object(
      'id', p_reward.id, 'name', p_reward.name, 'description', p_reward.description,
      'cost', p_reward.cost, 'enabled', p_reward.enabled,
      'availableFrom', p_reward.available_from, 'availableUntil', p_reward.available_until,
      'totalLimit', p_reward.total_limit, 'periodLimit', p_reward.period_limit,
      'limitPeriod', p_reward.limit_period, 'archived', p_reward.archived_at is not null,
      'revision', p_reward.revision,
      'block', v_block,
      'remaining', case when p_reward.total_limit is not null
        then greatest(p_reward.total_limit - private.personal_reward_used(p_reward), 0) end,
      'periodUsed', case when p_reward.period_limit is not null
        then private.personal_reward_period_used(p_reward, p_week_start, p_today) else 0 end,
      'nextEligibleOn', case when v_block = 'period_limit'
        then private.personal_period_next(p_reward.limit_period, p_week_start, p_today) end,
      'canAfford', p_available >= p_reward.cost,
      'redeemedCount', private.personal_reward_used(p_reward));
  end
  $$;

-- The caller's rewards, archived ones too when asked, by cost then name. p_today and p_week_start:
-- the caller's local date and effective week start (for windows and period limits).
create function public.list_personal_rewards(
  p_include_archived boolean default false, p_today date default null, p_week_start text default null
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_week_start text := private.personal_week_start(p_week_start);
    v_today date := private.personal_today(p_today);
    v_available integer := coalesce(
      (select a.balance from private.personal_point_accounts a where a.user_id = v_user_id), 0);
  begin
    return coalesce((select pg_catalog.jsonb_agg(
        private.personal_reward_json(r, v_week_start, v_today, v_available)
        order by r.archived_at is not null, r.cost, private.task_name_key(r.name), r.id)
      from private.personal_rewards r
      where r.user_id = v_user_id and (r.archived_at is null or coalesce(p_include_archived, false))),
      '[]'::jsonb);
  end
  $$;

-- Validates reward fields (22023 when invalid).
create function private.check_personal_reward_fields(
  p_name text, p_description text, p_cost integer, p_enabled boolean, p_available_from date,
  p_available_until date, p_total_limit integer, p_period_limit integer, p_limit_period text
) returns void
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_name is null or not private.is_visible_name(p_name, private.personal_points_limit('reward_name'))
       or (p_description is not null
         and not private.is_plain_text(p_description, private.personal_points_limit('reward_description')))
       or p_cost is null or p_cost not between 1 and private.personal_points_limit('cost')
       or p_enabled is null
       or (p_available_from is not null and p_available_from not between date '2000-01-01' and date '2199-12-31')
       or (p_available_until is not null and p_available_until not between date '2000-01-01' and date '2199-12-31')
       or p_available_until < p_available_from
       or (p_total_limit is not null
         and p_total_limit not between 1 and private.personal_points_limit('total_limit'))
       or (p_period_limit is null) <> (p_limit_period is null)
       or (p_period_limit is not null
         and p_period_limit not between 1 and private.personal_points_limit('period_limit'))
       or (p_limit_period is not null and p_limit_period not in ('week', 'month', 'year', 'ever')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
  end
  $$;

-- Creates one of the caller's rewards. p_id comes from the client, so a retry returns 'exists'.
-- Outcomes: 'created', 'exists', 'limit_reached' (200 active rewards).
create function public.create_personal_reward(
  p_id uuid, p_name text, p_cost integer, p_description text default null, p_enabled boolean default true,
  p_available_from date default null, p_available_until date default null,
  p_total_limit integer default null, p_period_limit integer default null, p_limit_period text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_description text := nullif(pg_catalog.btrim(p_description, E' \t\r\n'), '');
    v_existing private.personal_rewards;
  begin
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.check_personal_reward_fields(p_name, v_description, p_cost, p_enabled, p_available_from,
      p_available_until, p_total_limit, p_period_limit, p_limit_period);
    perform private.lock_personal_account(v_user_id);
    select * into v_existing from private.personal_rewards r where r.user_id = v_user_id and r.id = p_id;
    if found then
      return query select 'exists', v_existing.revision;
      return;
    end if;
    if (select count(*) from private.personal_rewards r where r.user_id = v_user_id and r.archived_at is null)
       >= private.personal_points_limit('rewards') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.personal_rewards (
      user_id, id, name, description, cost, enabled, available_from, available_until, total_limit,
      period_limit, limit_period
    ) values (
      v_user_id, p_id, p_name, v_description, p_cost, p_enabled, p_available_from, p_available_until,
      p_total_limit, p_period_limit, p_limit_period
    );
    return query select 'created', 1;
  end
  $$;

-- Changes one of the caller's rewards: every field at once, as the form shows them. Past
-- redemptions never change; a lower limit applies to new redemptions only. p_dry_run returns the
-- impact: how many times it was redeemed, and whether the cost changes. Outcomes: 'preview', 'saved'
-- (with impact), 'conflict' (with the current revision), 'archived', 'not_found'.
create function public.update_personal_reward(
  p_reward_id uuid, p_expected_revision integer, p_name text, p_cost integer,
  p_description text default null, p_enabled boolean default true,
  p_available_from date default null, p_available_until date default null,
  p_total_limit integer default null, p_period_limit integer default null, p_limit_period text default null,
  p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_description text := nullif(pg_catalog.btrim(p_description, E' \t\r\n'), '');
    v_reward private.personal_rewards;
    v_impact jsonb;
  begin
    if p_reward_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.check_personal_reward_fields(p_name, v_description, p_cost, p_enabled, p_available_from,
      p_available_until, p_total_limit, p_period_limit, p_limit_period);
    perform private.lock_personal_account(v_user_id);
    select * into v_reward from private.personal_rewards r
      where r.user_id = v_user_id and r.id = p_reward_id for update;
    if not found then
      return query select 'not_found', null::jsonb, null::integer;
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
    v_impact := pg_catalog.jsonb_build_object(
      'redeemed', private.personal_reward_used(v_reward),
      'costChanged', p_cost <> v_reward.cost,
      'totalReached', p_total_limit is not null and private.personal_reward_used(v_reward) >= p_total_limit);
    if p_dry_run then
      return query select 'preview', v_impact, v_reward.revision;
      return;
    end if;
    update private.personal_rewards r
      set name = p_name, description = v_description, cost = p_cost, enabled = p_enabled,
        available_from = p_available_from, available_until = p_available_until,
        total_limit = p_total_limit, period_limit = p_period_limit, limit_period = p_limit_period,
        revision = r.revision + 1, updated_at = pg_catalog.now()
      where r.user_id = v_user_id and r.id = v_reward.id
      returning * into v_reward;
    return query select 'saved', v_impact, v_reward.revision;
  end
  $$;

-- Archives one of the caller's rewards (it leaves the catalog; its redemptions and history stay) or
-- brings it back. Outcomes: 'saved', 'unchanged', 'conflict', 'limit_reached', 'not_found'.
create function public.archive_personal_reward(
  p_reward_id uuid, p_expected_revision integer, p_archived boolean
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reward private.personal_rewards;
  begin
    if p_reward_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_personal_account(v_user_id);
    select * into v_reward from private.personal_rewards r
      where r.user_id = v_user_id and r.id = p_reward_id for update;
    if not found then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_reward.revision <> p_expected_revision then
      return query select 'conflict', v_reward.revision;
      return;
    end if;
    if (v_reward.archived_at is not null) = p_archived then
      return query select 'unchanged', v_reward.revision;
      return;
    end if;
    if not p_archived and (select count(*) from private.personal_rewards r
        where r.user_id = v_user_id and r.archived_at is null) >= private.personal_points_limit('rewards') then
      return query select 'limit_reached', v_reward.revision;
      return;
    end if;
    update private.personal_rewards r
      set archived_at = case when p_archived then pg_catalog.now() end,
        revision = r.revision + 1, updated_at = pg_catalog.now()
      where r.user_id = v_user_id and r.id = v_reward.id
      returning * into v_reward;
    return query select 'saved', v_reward.revision;
  end
  $$;

-- Redemptions -------------------------------------------------------------------------------------------------

create function private.personal_redemption_event(
  p_user_id uuid, p_redemption_id uuid, p_kind text, p_note text, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.personal_reward_redemption_events (user_id, redemption_id, kind, note, details)
    values (p_user_id, p_redemption_id, p_kind, p_note, p_details);
  $$;

-- Redeems one of the caller's rewards at once. p_id comes from the client, so a retry returns
-- 'exists'. p_expected_cost is the cost the owner saw: a changed cost answers 'cost_changed'.
-- Everything is checked under the account's lock, then the reward's: availability, total and period
-- limits and the balance. The cost is deducted once and the redemption enters Pending fulfillment.
-- p_dry_run returns the preview: cost, available now and after. Outcomes: 'preview', 'redeemed',
-- 'exists', 'cost_changed', 'insufficient_points', 'archived', 'disabled', 'not_started', 'ended',
-- 'sold_out', 'period_limit' (with nextEligibleOn), 'not_found'.
create function public.redeem_personal_reward(
  p_id uuid, p_reward_id uuid, p_expected_cost integer, p_dry_run boolean default false,
  p_today date default null, p_week_start text default null
) returns table (outcome text, detail jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_week_start text := private.personal_week_start(p_week_start);
    v_today date := private.personal_today(p_today);
    v_account private.personal_point_accounts;
    v_reward private.personal_rewards;
    v_existing private.personal_reward_redemptions;
    v_block text;
    v_detail jsonb;
  begin
    if p_id is null or p_reward_id is null or p_expected_cost is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_account := private.lock_personal_account(v_user_id);
    select * into v_reward from private.personal_rewards r
      where r.user_id = v_user_id and r.id = p_reward_id for update;
    if not found then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    select * into v_existing from private.personal_reward_redemptions r where r.user_id = v_user_id and r.id = p_id;
    if found then
      if v_existing.reward_id <> p_reward_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', pg_catalog.jsonb_build_object('id', v_existing.id);
      return;
    end if;
    v_block := private.personal_reward_block(v_reward, v_week_start, v_today);
    if v_block is not null then
      return query select v_block, case when v_block = 'period_limit' then pg_catalog.jsonb_build_object(
        'nextEligibleOn', private.personal_period_next(v_reward.limit_period, v_week_start, v_today)) end;
      return;
    end if;
    v_detail := pg_catalog.jsonb_build_object('cost', v_reward.cost, 'available', v_account.balance,
      'availableAfter', v_account.balance - v_reward.cost);
    if v_reward.cost <> p_expected_cost then
      return query select 'cost_changed', v_detail;
      return;
    end if;
    if v_account.balance < v_reward.cost then
      return query select 'insufficient_points', v_detail;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_detail;
      return;
    end if;
    insert into private.personal_reward_redemptions (user_id, id, seq, reward_id, cost, reward_name, redeemed_on)
      values (v_user_id, p_id,
        coalesce((select max(r.seq) from private.personal_reward_redemptions r where r.user_id = v_user_id), 0) + 1,
        v_reward.id, v_reward.cost, v_reward.name, v_today);
    perform private.post_personal_entry(v_user_id, null, 'redemption', -v_reward.cost, null, p_id, null, null);
    perform private.personal_redemption_event(v_user_id, p_id, 'redeemed', null);
    return query select 'redeemed', v_detail || pg_catalog.jsonb_build_object('id', p_id);
  end
  $$;

-- One of the caller's redemptions locked for a change (account first, then the reward, then the
-- row); a null row when it is not theirs or does not exist.
create function private.lock_personal_redemption(p_user_id uuid, p_redemption_id uuid)
returns private.personal_reward_redemptions
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_redemption private.personal_reward_redemptions;
  begin
    perform private.lock_personal_account(p_user_id);
    perform 1 from private.personal_rewards w
      where w.user_id = p_user_id and w.id = (select r.reward_id from private.personal_reward_redemptions r
        where r.user_id = p_user_id and r.id = p_redemption_id)
      for update;
    select * into v_redemption from private.personal_reward_redemptions r
      where r.user_id = p_user_id and r.id = p_redemption_id for update;
    return v_redemption;
  end
  $$;

-- Records fulfillment of one of the caller's redemptions: Pending, Fulfilled or Unable to fulfill.
-- A change after Fulfilled or Unable (a correction) needs a reason; a resolved case is final.
-- Outcomes: 'saved', 'unchanged', 'already_resolved', 'reason_required', 'conflict', 'not_found'.
create function public.set_personal_reward_fulfillment(
  p_redemption_id uuid, p_expected_revision integer, p_state text, p_note text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_redemption private.personal_reward_redemptions;
    v_before text;
    v_correction boolean;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_state is null
       or p_state not in ('pending', 'fulfilled', 'unable')
       or (v_note is not null and not private.is_plain_text(v_note, private.personal_points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_personal_redemption(v_user_id, p_redemption_id);
    if v_redemption.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', v_redemption.revision;
      return;
    end if;
    if v_redemption.resolution is not null then
      return query select 'already_resolved', v_redemption.revision;
      return;
    end if;
    if v_redemption.fulfillment = p_state then
      return query select 'unchanged', v_redemption.revision;
      return;
    end if;
    v_before := v_redemption.fulfillment;
    v_correction := v_before <> 'pending';
    if v_correction and private.personal_reason(v_note) is null then
      return query select 'reason_required', v_redemption.revision;
      return;
    end if;
    update private.personal_reward_redemptions r
      set fulfillment = p_state, fulfillment_at = pg_catalog.now(), fulfillment_note = v_note,
        revision = r.revision + 1
      where r.user_id = v_user_id and r.id = v_redemption.id
      returning * into v_redemption;
    perform private.personal_redemption_event(v_user_id, v_redemption.id,
      case when v_correction then 'fulfillment_corrected' else p_state end, v_note,
      pg_catalog.jsonb_build_object('from', v_before, 'to', p_state));
    return query select 'saved', v_redemption.revision;
  end
  $$;

-- Resolves one of the caller's Unable-to-fulfill redemptions, once: 'refund' credits the cost back
-- (one linked entry), 'replacement' records what the owner chose instead (p_replacement, 1-200) and
-- never charges again. Optional note. p_dry_run returns the impact. Outcomes: 'preview', 'resolved',
-- 'not_unable', 'already_resolved', 'conflict', 'not_found'.
create function public.resolve_personal_reward_redemption(
  p_redemption_id uuid, p_expected_revision integer, p_resolution text, p_note text default null,
  p_replacement text default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_replacement text := private.chore_short_text(p_replacement);
    v_redemption private.personal_reward_redemptions;
    v_balance integer;
    v_impact jsonb;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_dry_run is null
       or p_resolution is null or p_resolution not in ('refund', 'replacement')
       or (v_note is not null and not private.is_plain_text(v_note, private.personal_points_limit('reason')))
       or (p_resolution = 'replacement' and (v_replacement is null
         or not private.is_plain_text(v_replacement, private.personal_points_limit('replacement'))))
       or (p_resolution = 'refund' and p_replacement is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_personal_redemption(v_user_id, p_redemption_id);
    if v_redemption.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if v_redemption.resolution is not null then
      return query select 'already_resolved', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.fulfillment <> 'unable' then
      return query select 'not_unable', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_redemption.revision;
      return;
    end if;
    select a.balance into v_balance from private.personal_point_accounts a where a.user_id = v_user_id;
    v_impact := pg_catalog.jsonb_build_object('resolution', p_resolution, 'cost', v_redemption.cost,
      'available', v_balance,
      'availableAfter', v_balance + case when p_resolution = 'refund' then v_redemption.cost else 0 end);
    if p_dry_run then
      return query select 'preview', v_impact, v_redemption.revision;
      return;
    end if;
    if p_resolution = 'refund' then
      perform private.post_personal_entry(v_user_id, null, 'refund', v_redemption.cost, null,
        v_redemption.id, null, null);
    end if;
    update private.personal_reward_redemptions r
      set resolution = p_resolution, resolved_at = pg_catalog.now(), resolution_note = v_note,
        replacement = case when p_resolution = 'replacement' then v_replacement end,
        revision = r.revision + 1
      where r.user_id = v_user_id and r.id = v_redemption.id
      returning * into v_redemption;
    perform private.personal_redemption_event(v_user_id, v_redemption.id,
      case p_resolution when 'refund' then 'refunded' else 'replacement' end, v_note,
      case when p_resolution = 'refund' then pg_catalog.jsonb_build_object('amount', v_redemption.cost)
        else pg_catalog.jsonb_build_object('replacement', v_replacement) end);
    return query select 'resolved', v_impact, v_redemption.revision;
  end
  $$;

-- The caller's redemptions, newest first, at most 100: 'all', or 'open' (Pending fulfillment, or
-- Unable to fulfill and not resolved).
create function public.list_personal_reward_redemptions(p_view text default 'all') returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_view is null or p_view not in ('all', 'open') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'rewardId', r.reward_id, 'rewardName', r.reward_name, 'cost', r.cost,
        'redeemedAt', r.redeemed_at, 'redeemedOn', r.redeemed_on, 'fulfillment', r.fulfillment,
        'fulfillmentAt', r.fulfillment_at, 'fulfillmentNote', r.fulfillment_note,
        'resolution', r.resolution, 'resolvedAt', r.resolved_at, 'resolutionNote', r.resolution_note,
        'replacement', r.replacement, 'revision', r.revision,
        'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', e.kind, 'at', e.created_at, 'note', e.note, 'details', e.details) order by e.id)
          from private.personal_reward_redemption_events e
          where e.user_id = v_user_id and e.redemption_id = r.id), '[]'::jsonb)
      ) order by r.seq desc)
      from (
        select * from private.personal_reward_redemptions x
        where x.user_id = v_user_id
          and (p_view = 'all' or x.fulfillment = 'pending' or (x.fulfillment = 'unable' and x.resolution is null))
        order by x.seq desc limit private.personal_points_limit('redemptions_page')
      ) r), '[]'::jsonb);
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_personal_points', 'adjust_personal_points', 'reverse_personal_point_entry',
      'list_personal_rewards', 'create_personal_reward', 'update_personal_reward',
      'archive_personal_reward', 'redeem_personal_reward', 'set_personal_reward_fulfillment',
      'resolve_personal_reward_redemption', 'list_personal_reward_redemptions'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in (
      'personal_points_limit', 'personal_points_append_only', 'lock_personal_account',
      'post_personal_entry', 'personal_reason', 'personal_today', 'personal_period_start',
      'personal_period_next', 'personal_reward_used', 'personal_reward_period_used',
      'personal_reward_block', 'personal_week_start', 'personal_totals', 'personal_reward_json',
      'check_personal_reward_fields', 'personal_redemption_event', 'lock_personal_redemption'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
