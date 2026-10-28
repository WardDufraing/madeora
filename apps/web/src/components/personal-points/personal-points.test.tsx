import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PersonalRedemption, PersonalReward } from "@/points/personal-api";
import { ToastProvider } from "@/components/ui/toast";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { PersonalAdjust } from "./personal-adjust";
import { PersonalRedemptionActions } from "./personal-redemption-actions";
import { PersonalRedeem } from "./personal-reward-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const REWARD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0080";
const REDEMPTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0081";

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
const answer = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function withToasts(node: React.ReactNode) {
  return (
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {node}
    </ToastProvider>
  );
}

function reward(extra: Partial<PersonalReward> = {}): PersonalReward {
  return {
    id: REWARD,
    name: "New book",
    description: null,
    cost: 30,
    enabled: true,
    availableFrom: null,
    availableUntil: null,
    totalLimit: null,
    periodLimit: null,
    limitPeriod: null,
    archived: false,
    revision: 1,
    block: null,
    remaining: null,
    periodUsed: 0,
    nextEligibleOn: null,
    canAfford: true,
    redeemedCount: 0,
    ...extra,
  };
}

function redemption(extra: Partial<PersonalRedemption> = {}): PersonalRedemption {
  return {
    id: REDEMPTION,
    rewardId: REWARD,
    rewardName: "New book",
    cost: 30,
    redeemedAt: "2026-10-28T09:00:00Z",
    redeemedOn: "2026-10-28",
    fulfillment: "pending",
    fulfillmentAt: null,
    fulfillmentNote: null,
    resolution: null,
    resolvedAt: null,
    resolutionNote: null,
    replacement: null,
    revision: 1,
    events: [],
    ...extra,
  };
}

describe("PersonalRedeem", () => {
  it("previews the balance after, then confirms exactly that request", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockImplementationOnce(() =>
        answer(200, {
          outcome: "preview",
          detail: { cost: 30, available: 45, availableAfter: 15 },
        }),
      )
      .mockImplementationOnce(() => answer(200, { outcome: "redeemed", detail: null }));
    const { container } = renderWithQuery(withToasts(<PersonalRedeem reward={reward()} />));

    await user.click(screen.getByRole("button", { name: "Redeem: New book" }));
    const dialog = screen.getByRole("dialog", { name: "Redeem New book?" });
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));

    expect(await within(dialog).findByTestId("personal-redeem-after")).toHaveTextContent("15");
    const first = bodyOf(fetchMock.mock.calls[0]?.[1]) as Record<string, unknown>;
    expect(first).toMatchObject({ rewardId: REWARD, expectedCost: 30, dryRun: true });
    expect(first).not.toHaveProperty("homeId");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/personal-reward-redemptions");
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Redeem" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ ...first, dryRun: false });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("explains a refusal for too few points and offers no confirm", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(() => answer(409, { error: "insufficient-points" }));
    renderWithQuery(withToasts(<PersonalRedeem reward={reward()} />));

    await user.click(screen.getByRole("button", { name: "Redeem: New book" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("There are not enough available points for this."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("personal-redeem-confirm")).not.toBeInTheDocument();
  });
});

describe("PersonalAdjust", () => {
  it("refuses a negative credit and a short reason before any request", async () => {
    const user = userEvent.setup();
    renderWithQuery(withToasts(<PersonalAdjust />));

    await user.click(screen.getByRole("button", { name: "Add points or correct" }));
    await user.type(screen.getByRole("spinbutton", { name: /Points/ }), "-5");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "ok");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      screen.getByText("Enter a whole number that is not 0 (adding points is always positive)."),
    ).toBeInTheDocument();
    expect(screen.getByText("Give a reason of at least 3 characters.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews a credit and posts it with the same id", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockImplementationOnce(() =>
        answer(200, {
          outcome: "preview",
          preview: { kind: "credit", amount: 10, available: 5, availableAfter: 15 },
          entryId: null,
        }),
      )
      .mockImplementationOnce(() =>
        answer(200, { outcome: "posted", preview: null, entryId: crypto.randomUUID() }),
      );
    const { container } = renderWithQuery(withToasts(<PersonalAdjust />));

    await user.click(screen.getByRole("button", { name: "Add points or correct" }));
    await user.type(screen.getByRole("spinbutton", { name: /Points/ }), "10");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Ran 5 km");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText("15")).toBeInTheDocument();
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const first = bodyOf(fetchMock.mock.calls[0]?.[1]) as Record<string, unknown>;
    expect(first).toMatchObject({ kind: "credit", amount: 10, reason: "Ran 5 km", dryRun: true });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ ...first, dryRun: false });
  });
});

describe("PersonalRedemptionActions", () => {
  it("offers fulfilled and unable while waiting, and no resolve", () => {
    renderWithQuery(withToasts(<PersonalRedemptionActions redemption={redemption()} />));
    expect(screen.getByRole("button", { name: "Mark fulfilled: New book" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unable to fulfill: New book" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve: New book" })).not.toBeInTheDocument();
  });

  it("offers a resolve once unable to fulfill", () => {
    renderWithQuery(
      withToasts(
        <PersonalRedemptionActions
          redemption={redemption({ fulfillment: "unable", revision: 2 })}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Resolve: New book" })).toBeInTheDocument();
  });

  it("shows nothing once resolved, because a resolution is final", () => {
    const { container } = renderWithQuery(
      withToasts(
        <PersonalRedemptionActions
          redemption={redemption({ fulfillment: "unable", resolution: "refund", revision: 3 })}
        />,
      ),
    );
    expect(within(container).queryAllByRole("button")).toEqual([]);
  });
});
