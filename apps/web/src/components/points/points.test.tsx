import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Reward } from "@/points/api";
import type { MemberNames } from "@/tasks/format";
import { ToastProvider } from "@/components/ui/toast";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { AdjustPoints } from "./adjust-points";
import { PointPreferences } from "./point-preferences";
import { RedeemReward } from "./reward-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const REWARD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";

const names: MemberNames = { byId: new Map([[BEA, "Bea"]]), selfId: null };

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

function reward(extra: Partial<Reward> = {}): Reward {
  return {
    id: REWARD,
    name: "Movie night",
    description: null,
    cost: 50,
    requiresApproval: false,
    enabled: true,
    availableFrom: null,
    availableUntil: null,
    totalLimit: null,
    memberLimit: null,
    memberPeriod: null,
    archived: false,
    revision: 1,
    block: null,
    remaining: null,
    myUsed: 0,
    nextEligibleOn: null,
    canAfford: true,
    pendingCount: null,
    redeemedCount: null,
    ...extra,
  };
}

describe("RedeemReward", () => {
  it("previews the cost and points after, then confirms exactly that request", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockImplementationOnce(() =>
        answer(200, {
          outcome: "preview",
          detail: {
            cost: 50,
            requiresApproval: false,
            available: 120,
            availableAfter: 70,
            reviewerAvailable: true,
          },
        }),
      )
      .mockImplementationOnce(() => answer(200, { outcome: "redeemed", detail: null }));
    const { container } = renderWithQuery(withToasts(<RedeemReward reward={reward()} />));

    await user.click(screen.getByRole("button", { name: "Redeem: Movie night" }));
    const dialog = screen.getByRole("dialog", { name: "Redeem Movie night?" });
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));

    const preview = await within(dialog).findByTestId("reward-redeem-preview");
    expect(within(preview).getByText("120")).toBeInTheDocument();
    expect(within(preview).getByText("70")).toBeInTheDocument();
    const first = bodyOf(fetchMock.mock.calls[0]?.[1]) as Record<string, unknown>;
    expect(first).toMatchObject({ rewardId: REWARD, expectedCost: 50, dryRun: true });
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Redeem" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const second = bodyOf(fetchMock.mock.calls[1]?.[1]) as Record<string, unknown>;
    expect(second).toEqual({ ...first, dryRun: false });
    expect((await screen.findAllByText("Reward redeemed.")).length).toBeGreaterThan(0);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("warns when nobody else can approve a request", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(() =>
      answer(200, {
        outcome: "preview",
        detail: {
          cost: 50,
          requiresApproval: true,
          available: 60,
          availableAfter: 10,
          reviewerAvailable: false,
        },
      }),
    );
    renderWithQuery(withToasts(<RedeemReward reward={reward({ requiresApproval: true })} />));

    await user.click(screen.getByRole("button", { name: "Request: Movie night" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText(
        "Nobody else can approve this right now. Your request waits until someone can.",
      ),
    ).toBeInTheDocument();
  });

  it("explains a refusal for too few available points", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(() => answer(409, { error: "insufficient-points" }));
    renderWithQuery(withToasts(<RedeemReward reward={reward()} />));

    await user.click(screen.getByRole("button", { name: "Redeem: Movie night" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("There are not enough available points for this."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("reward-redeem-confirm")).not.toBeInTheDocument();
  });
});

describe("AdjustPoints", () => {
  it("requires a meaningful reason and a valid amount before any request", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      withToasts(<AdjustPoints homeId={HOME} memberId={BEA} memberLabel="Bea" names={names} />),
    );

    await user.click(screen.getByRole("button", { name: "Bonus or correction for Bea" }));
    await user.type(screen.getByRole("spinbutton", { name: /Points/ }), "-5");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "ok");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      screen.getByText("Enter a whole number that is not 0 (a bonus is always positive)."),
    ).toBeInTheDocument();
    expect(screen.getByText("Give a reason of at least 3 characters.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews the available points after a bonus and applies it", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockImplementationOnce(() =>
        answer(200, {
          outcome: "preview",
          preview: {
            person: { me: false, member: BEA },
            kind: "bonus",
            amount: 10,
            available: 40,
            reserved: 5,
            availableAfter: 50,
          },
          entryId: null,
        }),
      )
      .mockImplementationOnce(() =>
        answer(200, { outcome: "posted", preview: null, entryId: crypto.randomUUID() }),
      );
    renderWithQuery(
      withToasts(<AdjustPoints homeId={HOME} memberId={BEA} memberLabel="Bea" names={names} />),
    );

    await user.click(screen.getByRole("button", { name: "Bonus or correction for Bea" }));
    await user.type(screen.getByRole("spinbutton", { name: /Points/ }), "10");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Helped with the move");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const preview = await screen.findByTestId("points-adjust-preview");
    expect(within(preview).getByText("50")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      homeId: HOME,
      memberId: BEA,
      kind: "bonus",
      amount: 10,
      reason: "Helped with the move",
      dryRun: true,
    });

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findAllByText("Points adjusted.")).length).toBeGreaterThan(0);
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ dryRun: false, amount: 10 });
  });
});

describe("PointPreferences", () => {
  it("saves the person's own choices, with an empty target as none", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(() => answer(200, { outcome: "saved" }));
    const { container } = renderWithQuery(
      <PointPreferences
        homeId={HOME}
        participates
        target={100}
        targetPaused={false}
        shareTarget={false}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByTestId("point-participates"));
    await user.clear(screen.getByTestId("point-target"));
    await user.click(screen.getByTestId("point-preferences-save"));

    expect(await screen.findByText("Your choices are saved.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      homeId: HOME,
      participates: false,
      target: null,
      targetPaused: false,
      shareTarget: false,
    });
  });
});
