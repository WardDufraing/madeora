// S23: the points and rewards routes. The database decides rights, balances, capacity and privacy
// (tests/db/rls/points-rewards.test.sql); these tests check what the routes send it and how they
// answer.
import type { Mock } from "vitest";

import {
  GET as choreOccurrencePoints,
  PUT as setOccurrencePoints,
} from "../chore-occurrences/[occurrenceId]/points/route";
import { GET as leaderboard } from "../leaderboard/route";
import { POST as adjust } from "../point-adjustments/route";
import { POST as reverse } from "../point-entries/[entryId]/reversal/route";
import { PUT as savePreferences } from "../point-preferences/route";
import { PUT as saveSettings } from "../point-settings/route";
import { PATCH as changeRedemption } from "../reward-redemptions/[redemptionId]/route";
import { POST as redeem } from "../reward-redemptions/route";
import { PATCH as changeReward } from "../rewards/[rewardId]/route";
import { POST as createReward } from "../rewards/route";
import { GET as accounts } from "./accounts/route";
import { GET as summary } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";
const REWARD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091";
const REDEMPTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0092";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
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

const preview = {
  person: { me: false, member: MEMBER },
  kind: "correction",
  amount: -5,
  available: 3,
  reserved: 2,
  availableAfter: -2,
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("adjustments", () => {
  const body = {
    id: ENTRY,
    homeId: HOME,
    memberId: MEMBER,
    kind: "correction",
    amount: -5,
    reason: "  Counted   twice ",
    dryRun: true,
  };

  it("sends the change with the normalized reason and answers the preview", async () => {
    answers({ adjust_points: [{ outcome: "preview", preview, entry_id: null }] });
    const response = await adjust(request("/point-adjustments", "POST", body));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("adjust_points", {
      p_id: ENTRY,
      p_home_id: HOME,
      p_member: MEMBER,
      p_kind: "correction",
      p_amount: -5,
      p_reason: "Counted twice",
      p_dry_run: true,
    });
    expect(await response.json()).toEqual({ outcome: "preview", preview, entryId: null });
  });

  it("refuses a debit below zero with the preview, and nothing applied", async () => {
    answers({ adjust_points: [{ outcome: "insufficient_points", preview, entry_id: null }] });
    const response = await adjust(
      request("/point-adjustments", "POST", { ...body, dryRun: false }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "insufficient-points", preview });
  });

  it("refuses a negative bonus, a short reason and a cross-site request before the database", async () => {
    for (const bad of [
      { ...body, kind: "bonus" },
      { ...body, reason: "ok" },
      { ...body, amount: 0 },
    ]) {
      expect((await adjust(request("/point-adjustments", "POST", bad))).status).toBe(400);
    }
    expect((await adjust(request("/point-adjustments", "POST", body, crossSite))).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers someone without the right as not permitted", async () => {
    answers({ adjust_points: [{ outcome: "not_permitted", preview: null, entry_id: null }] });
    const response = await adjust(request("/point-adjustments", "POST", body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not-permitted" });
  });

  it("reverses an entry once", async () => {
    answers({
      reverse_point_entry: [{ outcome: "already_reversed", preview: null, entry_id: ENTRY }],
    });
    const response = await reverse(
      request(`/point-entries/${ENTRY}/reversal`, "POST", { reason: "Mistake", dryRun: false }),
      params("entryId", ENTRY),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already-reversed" });
    expect(state.rpc).toHaveBeenCalledWith("reverse_point_entry", {
      p_entry_id: ENTRY,
      p_reason: "Mistake",
      p_dry_run: false,
    });
  });
});

describe("reading points", () => {
  it("answers a Home the person is not in as not found, never a balance", async () => {
    state.rpc.mockImplementation(() => ({
      data: null,
      error: { code: "42501", message: "not permitted" },
    }));
    const response = await summary(request(`/points?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
  });

  it("answers the accounts overview as not found for someone who may not manage points", async () => {
    state.rpc.mockImplementation(() => ({
      data: null,
      error: { code: "42501", message: "not permitted" },
    }));
    expect((await accounts(request(`/points/accounts?homeId=${HOME}`, "GET"))).status).toBe(404);
  });

  it("refuses a signed-out reader and an unknown period", async () => {
    expect(
      (await leaderboard(request(`/leaderboard?homeId=${HOME}&period=year`, "GET"))).status,
    ).toBe(400);
    state.identity = null;
    expect((await summary(request(`/points?homeId=${HOME}`, "GET"))).status).toBe(401);
  });

  it("asks the database for the point change of a correction", async () => {
    answers({ preview_chore_points_change: null });
    const response = await choreOccurrencePoints(
      request(
        `/chore-occurrences/${OCCURRENCE}/points?preview=correct&contributor=${MEMBER}`,
        "GET",
      ),
      params("occurrenceId", OCCURRENCE),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ change: null });
    expect(state.rpc).toHaveBeenCalledWith("preview_chore_points_change", {
      p_occurrence_id: OCCURRENCE,
      p_action: "correct",
      p_contributor: MEMBER,
    });
  });
});

describe("preferences and settings", () => {
  it("saves only the person's own choices; a cleared target removes it", async () => {
    answers({ update_point_preferences: "saved" });
    const response = await savePreferences(
      request("/point-preferences", "PUT", { homeId: HOME, participates: false, target: null }),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_point_preferences", {
      p_home_id: HOME,
      p_participates: false,
      p_set_target: true,
    });
  });

  it("refuses leaderboard settings without the right", async () => {
    answers({ update_point_settings: "not_permitted" });
    const response = await saveSettings(
      request("/point-settings", "PUT", {
        homeId: HOME,
        leaderboardEnabled: true,
        defaultPeriod: "week",
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("rewards", () => {
  const reward = {
    id: REWARD,
    homeId: HOME,
    name: "  Movie night ",
    description: "",
    cost: 50,
    requiresApproval: true,
    enabled: true,
    availableFrom: null,
    availableUntil: null,
    totalLimit: null,
    memberLimit: 1,
    memberPeriod: "week",
  };

  it("creates one with the trimmed name and only the limits it has", async () => {
    answers({ create_reward: [{ outcome: "created", revision: 1 }] });
    const response = await createReward(request("/rewards", "POST", reward));
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_reward", {
      p_id: REWARD,
      p_home_id: HOME,
      p_name: "Movie night",
      p_cost: 50,
      p_requires_approval: true,
      p_enabled: true,
      p_member_limit: 1,
      p_member_period: "week",
    });
  });

  it("refuses a member limit without its period, and an end before the start", async () => {
    for (const bad of [
      { ...reward, memberPeriod: null },
      { ...reward, availableFrom: "2026-11-10", availableUntil: "2026-11-01" },
    ]) {
      expect((await createReward(request("/rewards", "POST", bad))).status).toBe(400);
    }
  });

  it("archives with the revision seen and reports a conflict", async () => {
    answers({ archive_reward: [{ outcome: "conflict", impact: null, revision: 4 }] });
    const response = await changeReward(
      request(`/rewards/${REWARD}`, "PATCH", { action: "archive", expectedRevision: 3 }),
      params("rewardId", REWARD),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 4 });
    expect(state.rpc).toHaveBeenCalledWith("archive_reward", {
      p_reward_id: REWARD,
      p_expected_revision: 3,
      p_archived: true,
    });
  });
});

describe("redemptions", () => {
  const redeemBody = { id: REDEMPTION, rewardId: REWARD, expectedCost: 50, dryRun: false };

  it("redeems with the cost the member saw, and refuses a changed cost", async () => {
    answers({
      redeem_reward: [
        {
          outcome: "cost_changed",
          detail: {
            cost: 60,
            requiresApproval: false,
            available: 80,
            availableAfter: 20,
            reviewerAvailable: true,
          },
        },
      ],
    });
    const response = await redeem(request("/reward-redemptions", "POST", redeemBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "cost-changed", detail: { cost: 60 } });
    expect(state.rpc).toHaveBeenCalledWith("redeem_reward", {
      p_id: REDEMPTION,
      p_reward_id: REWARD,
      p_expected_cost: 50,
      p_dry_run: false,
    });
  });

  it("says when the member may redeem again", async () => {
    answers({
      redeem_reward: [{ outcome: "member_limit", detail: { nextEligibleOn: "2026-11-09" } }],
    });
    const response = await redeem(request("/reward-redemptions", "POST", redeemBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "member-limit", nextEligibleOn: "2026-11-09" });
  });

  it("never lets a requester approve their own request", async () => {
    answers({ review_reward_redemption: [{ outcome: "own_request", detail: null, revision: 1 }] });
    const response = await changeRedemption(
      request(`/reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "approve",
        expectedRevision: 1,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "own-request" });
    expect(state.rpc).toHaveBeenCalledWith("review_reward_redemption", {
      p_redemption_id: REDEMPTION,
      p_expected_revision: 1,
      p_decision: "approve",
      p_confirm: false,
    });
  });

  it("asks for confirmation when the reward became unavailable", async () => {
    answers({
      review_reward_redemption: [
        { outcome: "reward_unavailable", detail: { reason: "archived" }, revision: 2 },
      ],
    });
    const response = await changeRedemption(
      request(`/reward-redemptions/${REDEMPTION}`, "PATCH", {
        action: "approve",
        expectedRevision: 2,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "reward-unavailable", revision: 2 });
  });

  it("resolves with a refund or a replacement, never both", async () => {
    const replacementWithoutResponsible = {
      action: "resolve",
      expectedRevision: 3,
      resolution: "replacement",
      note: null,
      replacement: "Pizza instead",
      responsible: null,
      dryRun: true,
    };
    expect(
      (
        await changeRedemption(
          request(`/reward-redemptions/${REDEMPTION}`, "PATCH", replacementWithoutResponsible),
          params("redemptionId", REDEMPTION),
        )
      ).status,
    ).toBe(400);
    answers({
      resolve_reward_redemption: [{ outcome: "resolved", impact: { refund: 50 }, revision: 4 }],
    });
    const response = await changeRedemption(
      request(`/reward-redemptions/${REDEMPTION}`, "PATCH", {
        ...replacementWithoutResponsible,
        resolution: "refund",
        replacement: null,
        dryRun: false,
      }),
      params("redemptionId", REDEMPTION),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("resolve_reward_redemption", {
      p_redemption_id: REDEMPTION,
      p_expected_revision: 3,
      p_resolution: "refund",
      p_dry_run: false,
    });
  });
});

describe("occurrence points", () => {
  it("sends a correction with its reason and maps a missing right", async () => {
    answers({
      set_chore_occurrence_points: [{ outcome: "points_not_permitted", impact: null, revision: 7 }],
    });
    const response = await setOccurrencePoints(
      request(`/chore-occurrences/${OCCURRENCE}/points`, "PUT", {
        expectedRevision: 7,
        setting: { points: 12, latePolicy: "reduced", latePoints: 4 },
        reason: "Was harder",
        dryRun: true,
      }),
      params("occurrenceId", OCCURRENCE),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "points-not-permitted", revision: 7 });
    expect(state.rpc).toHaveBeenCalledWith("set_chore_occurrence_points", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 7,
      p_points: 12,
      p_late_policy: "reduced",
      p_late_points: 4,
      p_reason: "Was harder",
      p_dry_run: true,
    });
  });

  it("refuses a reduced amount above the base value before the database", async () => {
    const response = await setOccurrencePoints(
      request(`/chore-occurrences/${OCCURRENCE}/points`, "PUT", {
        expectedRevision: 7,
        setting: { points: 3, latePolicy: "reduced", latePoints: 4 },
        reason: null,
        dryRun: true,
      }),
      params("occurrenceId", OCCURRENCE),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
