import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import { axeViolations } from "@/test/axe";
import { dictionaries, renderWithQuery } from "@/test/intl";

import { RecoveryAppealForm } from "./recovery-appeal-form";
import { RecoveryClaimantActions } from "./recovery-claimant-actions";
import { RecoveryObjectionForm } from "./recovery-objection-form";
import { RecoveryOwnerCancel } from "./recovery-owner-cancel";
import { RecoveryRequestForm } from "./recovery-request-form";
import { StaffCloseAppealForm } from "./staff-close-appeal-form";
import { StaffDecisionForm } from "./staff-decision-form";
import { staffActionsFor } from "./staff-state-label";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CASE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const APPEAL_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const STATEMENT =
  "The Owner moved abroad in March and answers neither calls nor email. You can call me on video.";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockClear();
  router.refresh.mockClear();
});

describe("RecoveryRequestForm", () => {
  it("sends the statement with one request id, and reuses it on retry", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(answer(500, { error: "failed" }))
      .mockReturnValueOnce(answer(201, { recovery: { id: CASE_ID } }));
    const { container } = renderWithQuery(<RecoveryRequestForm homeId={HOME_ID} />);
    const field = screen.getByRole("textbox", { name: /Your statement for Madeora staff/ });
    expect(field).toHaveAccessibleDescription(/how staff can verify who you are/);
    await user.type(field, STATEMENT);
    await user.click(screen.getByRole("button", { name: "Send to Madeora staff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not work");
    await user.click(screen.getByRole("button", { name: "Send to Madeora staff" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}/recovery?requested=1`, {
        scroll: false,
      });
    });
    const [first, second] = fetchMock.mock.calls;
    expect(first?.[0]).toBe(`/api/v1/homes/${HOME_ID}/ownership-recoveries`);
    const firstBody = bodyOf(first?.[1]) as { statement: string; requestId: string };
    expect(firstBody.statement).toBe(STATEMENT);
    expect(bodyOf(second?.[1])).toEqual(firstBody);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("asks for a longer statement before sending anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(<RecoveryRequestForm homeId={HOME_ID} />);
    await user.type(screen.getByRole("textbox"), "Help.");
    await user.click(screen.getByRole("button", { name: "Send to Madeora staff" }));
    expect(await screen.findByText("Write at least 50 characters.")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains who may ask when the database refuses, in Dutch", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(403, { error: "not-permitted" }));
    renderWithQuery(<RecoveryRequestForm homeId={HOME_ID} />, "nl");
    await user.type(screen.getByRole("textbox"), STATEMENT);
    await user.click(screen.getByRole("button", { name: "Naar Madeora sturen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("minstens 30 dagen");
  });
});

describe("RecoveryClaimantActions", () => {
  it("accepts ownership only after confirming what it means", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    const { container } = renderWithQuery(
      <RecoveryClaimantActions homeId={HOME_ID} homeName="Thuis" recoveryId={CASE_ID} canAccept />,
    );
    await user.click(screen.getByRole("button", { name: "Accept ownership" }));
    const dialog = screen.getByRole("dialog", { name: "Become the Owner of Thuis?" });
    expect(dialog).toHaveTextContent("You become the only Owner");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Become Owner" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}?recovery=accepted`, {
        scroll: false,
      });
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/ownership-recoveries/${CASE_ID}/accept`,
    );
  });

  it("offers only withdrawal before the request is ready, and explains a late refusal", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "owner-returned" }));
    renderWithQuery(
      <RecoveryClaimantActions
        homeId={HOME_ID}
        homeName="Thuis"
        recoveryId={CASE_ID}
        canAccept={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accept ownership" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Withdraw request" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("still have access");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/ownership-recoveries/${CASE_ID}/withdraw`,
    );
  });
});

describe("RecoveryObjectionForm", () => {
  it("sends the reason and confirms the pause", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    const { container } = renderWithQuery(<RecoveryObjectionForm homeId={HOME_ID} />);
    await user.type(
      screen.getByRole("textbox", { name: /Your reason/ }),
      "I spoke with the Owner yesterday.",
    );
    await user.click(screen.getByRole("button", { name: "Object" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}/recovery?objected=1`, {
        scroll: false,
      });
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      reason: "I spoke with the Owner yesterday.",
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("RecoveryOwnerCancel", () => {
  it("ends the requests and says nothing changes", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { cancelled: 1 }));
    renderWithQuery(<RecoveryOwnerCancel homeId={HOME_ID} />);
    await user.click(screen.getByRole("button", { name: "I still have access" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing changes in your Home.");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/ownership-recoveries/cancel`,
    );
  });
});

describe("RecoveryAppealForm", () => {
  it("sends the appeal for this recovery", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    const { container } = renderWithQuery(
      <RecoveryAppealForm recoveryId={CASE_ID} homeName="Thuis" />,
    );
    await user.type(
      screen.getByRole("textbox", { name: /Your appeal about Thuis/ }),
      "I was travelling and never lost access.",
    );
    await user.click(screen.getByRole("button", { name: "Send appeal" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/settings/recoveries?appealed=1", {
        scroll: false,
      });
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/me/ownership-recoveries/${CASE_ID}/appeal`);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("StaffDecisionForm", () => {
  it("offers the actions that fit each state", () => {
    expect(staffActionsFor("submitted")).toEqual(["start_review", "pause", "reject"]);
    expect(staffActionsFor("in_review")).toEqual(["approve", "pause", "reject"]);
    expect(staffActionsFor("paused")).toEqual(["resume", "reject"]);
    expect(staffActionsFor("completed")).toEqual([]);
  });

  it("approves with a note and the former Owner's outcome, and says the people involved are notified", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { notified: true }));
    const { container } = renderWithQuery(
      <StaffDecisionForm recoveryId={CASE_ID} actions={staffActionsFor("in_review")} />,
    );
    expect(screen.getByRole("radio", { name: /Approve/ })).toBeChecked();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("radio", { name: "Is removed from the Home" }));
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByText("Write at least 10 characters.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Video call with ID done.");
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Decision saved. The people involved are being notified; emails go out within a few minutes.",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/staff/ownership-recoveries/${CASE_ID}/decision`,
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      action: "approve",
      notes: "Video call with ID done.",
      formerOwnerOutcome: "removed",
    });
  });

  it("keeps the confirmation and selects an action that still fits after the state changes", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { notified: true }));
    const { rerender } = renderWithQuery(
      <StaffDecisionForm recoveryId={CASE_ID} actions={staffActionsFor("submitted")} />,
    );
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Decision saved.");
    rerender(
      <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
        <QueryClientProvider client={new QueryClient()}>
          <StaffDecisionForm recoveryId={CASE_ID} actions={staffActionsFor("in_review")} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(await screen.findByRole("radio", { name: /Approve/ })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Decision saved.");
  });

  it("sends no outcome for other actions and asks for a fresh sign-in when needed", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(401, { error: "reauthenticate" }));
    renderWithQuery(
      <StaffDecisionForm recoveryId={CASE_ID} actions={staffActionsFor("submitted")} />,
    );
    expect(screen.queryByRole("radio", { name: "Stays as a Member" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("within the last 15 minutes");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      action: "start_review",
      notes: "",
      formerOwnerOutcome: null,
    });
  });
});

describe("StaffCloseAppealForm", () => {
  it("closes the appeal with a note", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    renderWithQuery(<StaffCloseAppealForm appealId={APPEAL_ID} />);
    await user.type(
      screen.getByRole("textbox", { name: /Your note to close this appeal/ }),
      "Recovery stands; explained the transfer route.",
    );
    await user.click(screen.getByRole("button", { name: "Close appeal" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/staff/recovery-appeals/${APPEAL_ID}/close`);
  });
});
