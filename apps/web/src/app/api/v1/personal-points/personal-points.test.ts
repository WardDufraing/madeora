// S28b: the personal points and rewards routes. The database decides ownership, balances and
// limits (tests/db/rls/personal-points-rewards.test.sql); these tests check what the routes send it,
// that nothing names a Home or another owner, and how they answer.
import type { Mock } from "vitest";

import { POST as adjust } from "../personal-point-adjustments/route";
import { POST as reverse } from "../personal-point-entries/[entryId]/reversal/route";
import { PATCH as changeRedemption } from "../personal-reward-redemptions/[redemptionId]/route";
import { GET as listRedemptions, POST as redeem } from "../personal-reward-redemptions/route";
import { PATCH as changeReward } from "../personal-rewards/[rewardId]/route";
import { GET as listRewards, POST as createReward } from "../personal-rewards/route";
import { GET as points } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";
const REWARD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091";
const REDEMPTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0092";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Pacific/Kiritimati", source: "chosen" }),
  getRegionalFormats: () => Promise.resolve({ effective: { weekStart: "sunday" } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

/** Today in the mocked owner's zone (UTC+14), never the server's or a Home's. */
function ownerToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("personal points", () => {
  it("reads only the caller's own ledger, with no owner argument", async () => {
    const ledger = { totals: { available: 5, earned: 5, spent: 0 }, entries: [], next: null };
    answers({ get_personal_points: ledger });
    const response = await points(request("/personal-points?before=9", "GET"));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("get_personal_points", { p_before: 9 });
    expect(await response.json()).toEqual(ledger);
  });

  it("refuses a homeId or another owner instead of ignoring it", async () => {
    for (const query of [`homeId=${HOME}`, "userId=someone", "accountId=x"]) {
      const response = await points(request(`/personal-points?${query}`, "GET"));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 without a verified identity", async () => {
    state.identity = null;
    expect((await points(request("/personal-points", "GET"))).status).toBe(401);
    expect((await listRewards(request("/personal-rewards", "GET"))).status).toBe(401);
  });
});

describe("adjustments", () => {
  const body = { id: ENTRY, kind: "credit", amount: 10, reason: "  Ran   10 km ", dryRun: true };

  it("sends the credit with the normalized reason and answers the preview", async () => {
    const preview = { kind: "credit", amount: 10, available: 0, availableAfter: 10 };
    answers({ adjust_personal_points: [{ outcome: "preview", preview, entry_id: null }] });
    const response = await adjust(request("/personal-point-adjustments", "POST", body));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("adjust_personal_points", {
      p_id: ENTRY,
      p_kind: "credit",
      p_amount: 10,
      p_reason: "Ran 10 km",
      p_dry_run: true,
    });
    expect(await response.json()).toEqual({ outcome: "preview", preview, entryId: null });
  });

  it("refuses a homeId, a Home kind, a negative credit and a short reason", async () => {
    for (const invalid of [
      { ...body, homeId: HOME },
      { ...body, userId: "someone-else" },
      { ...body, kind: "bonus" },
      { ...body, amount: -10 },
      { ...body, amount: 0 },
      { ...body, amount: 100001 },
      { ...body, reason: "ok" },
    ]) {
      const response = await adjust(request("/personal-point-adjustments", "POST", invalid));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before anything else", async () => {
    const response = await adjust(request("/personal-point-adjustments", "POST", body, crossSite));
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers insufficient points with the preview", async () => {
    const preview = { kind: "correction", amount: -9, available: 3, availableAfter: -6 };
    answers({
      adjust_personal_points: [{ outcome: "insufficient_points", preview, entry_id: null }],
    });
    const response = await adjust(
      request("/personal-point-adjustments", "POST", { ...body, kind: "correction", amount: -9 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "insufficient-points", preview });
  });

  it("reverses an entry once, and answers another person's entry as not found", async () => {
    answers({
      reverse_personal_point_entry: [
        { outcome: "already_reversed", preview: null, entry_id: ENTRY },
      ],
    });
    const again = await reverse(
      request(`/personal-point-entries/${ENTRY}/reversal`, "POST", {
        reason: "Not really",
        dryRun: false,
      }),
      params("entryId", ENTRY),
    );
    expect(again.status).toBe(409);
    answers({
      reverse_personal_point_entry: [{ outcome: "not_found", preview: null, entry_id: null }],
    });
    const foreign = await reverse(
      request(`/personal-point-entries/${ENTRY}/reversal`, "POST", {
        reason: "Not mine",
        dryRun: false,
      }),
      params("entryId", ENTRY),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("rewards", () => {
  const reward = {
    id: REWARD,
    name: "Ice cream",
    description: "",
    cost: 30,
    enabled: true,
    availableFrom: null,
    availableUntil: null,
    totalLimit: null,
    periodLimit: 1,
    limitPeriod: "week",
  };

  it("creates a reward with only the fields given", async () => {
    answers({ create_personal_reward: [{ outcome: "created", revision: 1 }] });
    const response = await createReward(request("/personal-rewards", "POST", reward));
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_personal_reward", {
      p_id: REWARD,
      p_name: "Ice cream",
      p_cost: 30,
      p_enabled: true,
      p_period_limit: 1,
      p_limit_period: "week",
    });
  });

  it("refuses an approval setting, a homeId and a period limit without its period", async () => {
    for (const invalid of [
      { ...reward, requiresApproval: true },
      { ...reward, homeId: HOME },
      { ...reward, limitPeriod: null },
      { ...reward, cost: 0 },
      { ...reward, availableFrom: "2026-11-10", availableUntil: "2026-11-01" },
    ]) {
      const response = await createReward(request("/personal-rewards", "POST", invalid));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lists rewards in the owner's own timezone and week", async () => {
    answers({ list_personal_rewards: [] });
    const response = await listRewards(request("/personal-rewards?archived=true", "GET"));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("list_personal_rewards", {
      p_include_archived: true,
      p_today: ownerToday(),
      p_week_start: "sunday",
    });
  });

  it("edits with a preview and archives", async () => {
    answers({
      update_personal_reward: [{ outcome: "preview", impact: { redeemed: 2 }, revision: 3 }],
    });
    const { id: _id, ...fields } = reward;
    const edit = await changeReward(
      request(`/personal-rewards/${REWARD}`, "PATCH", {
        action: "edit",
        expectedRevision: 3,
        dryRun: true,
        ...fields,
      }),
      params("rewardId", REWARD),
    );
    expect(edit.status).toBe(200);
    expect(await edit.json()).toEqual({ outcome: "preview", impact: { redeemed: 2 }, revision: 3 });
    answers({ archive_personal_reward: [{ outcome: "saved", revision: 4 }] });
    const archive = await changeReward(
      request(`/personal-rewards/${REWARD}`, "PATCH", { action: "archive", expectedRevision: 3 }),
      params("rewardId", REWARD),
    );
    expect(archive.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("archive_personal_reward", {
      p_reward_id: REWARD,
      p_expected_revision: 3,
      p_archived: true,
    });
  });
});

describe("redemptions", () => {
  it("redeems with the owner's today and week start, and answers a period limit", async () => {
    answers({
      redeem_personal_reward: [
        { outcome: "period_limit", detail: { nextEligibleOn: "2026-11-01" } },
      ],
    });
    const response = await redeem(
      request("/personal-reward-redemptions", "POST", {
        id: REDEMPTION,
        rewardId: REWARD,
        expectedCost: 30,
        dryRun: false,
      }),
    );
    expect(state.rpc).toHaveBeenCalledWith("redeem_personal_reward", {
      p_id: REDEMPTION,
      p_reward_id: REWARD,
      p_expected_cost: 30,
      p_dry_run: false,
      p_today: ownerToday(),
      p_week_start: "sunday",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "member-limit", nextEligibleOn: "2026-11-01" });
  });

  it("answers insufficient points and a changed cost", async () => {
    const body = { id: REDEMPTION, rewardId: REWARD, expectedCost: 30, dryRun: false };
    answers({ redeem_personal_reward: [{ outcome: "insufficient_points", detail: { cost: 30 } }] });
    expect((await redeem(request("/personal-reward-redemptions", "POST", body))).status).toBe(409);
    answers({ redeem_personal_reward: [{ outcome: "cost_changed", detail: { cost: 40 } }] });
    const changed = await redeem(request("/personal-reward-redemptions", "POST", body));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "cost-changed" });
  });

  it("lists the caller's redemptions by view", async () => {
    answers({ list_personal_reward_redemptions: [] });
    const response = await listRedemptions(
      request("/personal-reward-redemptions?view=open", "GET"),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("list_personal_reward_redemptions", { p_view: "open" });
    expect(
      (await listRedemptions(request("/personal-reward-redemptions?view=mine", "GET"))).status,
    ).toBe(400);
  });

  it("records fulfillment and resolves with a refund or a replacement", async () => {
    answers({ set_personal_reward_fulfillment: [{ outcome: "saved", revision: 2 }] });
    const fulfil = await changeRedemption(
      request(`/personal-reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "fulfillment",
        expectedRevision: 1,
        state: "unable",
        note: null,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(fulfil.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_personal_reward_fulfillment", {
      p_redemption_id: REDEMPTION,
      p_expected_revision: 1,
      p_state: "unable",
    });
    answers({
      resolve_personal_reward_redemption: [
        { outcome: "resolved", impact: { resolution: "replacement" }, revision: 3 },
      ],
    });
    const resolved = await changeRedemption(
      request(`/personal-reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "resolve",
        expectedRevision: 2,
        resolution: "replacement",
        note: null,
        replacement: "  A film   at home ",
        dryRun: false,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(resolved.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("resolve_personal_reward_redemption", {
      p_redemption_id: REDEMPTION,
      p_expected_revision: 2,
      p_resolution: "replacement",
      p_dry_run: false,
      p_replacement: "A film at home",
    });
  });

  it("refuses a replacement without text and a refund with one", async () => {
    for (const invalid of [
      { resolution: "replacement", replacement: null },
      { resolution: "replacement", replacement: "   " },
      { resolution: "refund", replacement: "Something" },
    ]) {
      const response = await changeRedemption(
        request(`/personal-reward-redemptions/${REDEMPTION}`, "PATCH", {
          action: "resolve",
          expectedRevision: 2,
          note: null,
          dryRun: false,
          ...invalid,
        }),
        params("redemptionId", REDEMPTION),
      );
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a resolved case as final and another person's redemption as not found", async () => {
    answers({ set_personal_reward_fulfillment: [{ outcome: "already_resolved", revision: 3 }] });
    const final = await changeRedemption(
      request(`/personal-reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "fulfillment",
        expectedRevision: 3,
        state: "fulfilled",
        note: "Changed my mind",
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(final.status).toBe(409);
    answers({ set_personal_reward_fulfillment: [{ outcome: "not_found", revision: null }] });
    const foreign = await changeRedemption(
      request(`/personal-reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "fulfillment",
        expectedRevision: 1,
        state: "unable",
        note: null,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(foreign.status).toBe(404);
  });
});
