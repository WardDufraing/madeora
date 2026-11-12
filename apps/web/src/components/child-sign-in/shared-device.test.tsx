import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DevicePinSetting } from "@/components/security/device-pin-setting";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import {
  HouseholdChores,
  type HouseholdChore,
  type HouseholdChoreMember,
} from "./household-chores";
import { SharedDevicePinRule } from "./shared-device-pin-rule";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const ADULT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const MIA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const NOOR = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0032";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";
const ACTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061";

const members: readonly HouseholdChoreMember[] = [
  { membershipId: ADULT, name: "Erin", accentColor: null, isChild: false, hasPin: true },
  { membershipId: MIA, name: "Mia", accentColor: "#3366ff", isChild: true, hasPin: true },
  { membershipId: NOOR, name: "Noor", accentColor: null, isChild: true, hasPin: false },
];
const chore: HouseholdChore = {
  occurrenceId: OCCURRENCE,
  title: "Feed the cat",
  dueLabel: "10 Nov",
  overdue: true,
  assigneeIds: [MIA],
  mandatoryOpen: 0,
  requiresApproval: false,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("HouseholdChores", () => {
  it("names who did a chore, completes it without a PIN, and undoes it", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <HouseholdChores requirePin={false} members={members} chores={[chore]} />,
    );
    expect(screen.getByText("Overdue since 10 Nov")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Feed the cat/ }));

    // Noor is a child not assigned to this chore, so she cannot be named.
    expect(screen.getByRole("heading", { name: "Who completed this?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erin" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Noor" })).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Mia" }));

    expect(screen.getByTestId("household-chore-summary")).toHaveTextContent(
      "Mia completed Feed the cat.",
    );
    expect(screen.queryByLabelText(/PIN for Mia/)).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    fetchMock.mockReturnValueOnce(answer(200, { outcome: "completed", actionId: ACTION }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Feed the cat is done.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/household/chores/complete");
    expect(bodyOf(init)).toEqual({ occurrenceId: OCCURRENCE, membershipId: MIA, pin: null });

    fetchMock.mockReturnValueOnce(answer(200, {}));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone: Feed the cat.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ actionId: ACTION });
    expect(router.refresh).toHaveBeenCalledTimes(2);

    // Done goes back to the list; nothing about Mia is kept.
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("heading", { name: "Which chore is done?" })).toBeInTheDocument();
  });

  it("asks for the PIN when the Home requires one and clears it after a refusal", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HouseholdChores requirePin members={members} chores={[chore]} />);
    await user.click(screen.getByRole("button", { name: /Feed the cat/ }));
    await user.click(screen.getByRole("button", { name: "Erin" }));
    expect(screen.getByText("This Home asks for a PIN to confirm.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("PIN for Erin"), "12a");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText("That didn't work. Check the PIN and try again."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockReturnValueOnce(answer(401, { error: "invalid-pin" }));
    await user.clear(screen.getByLabelText("PIN for Erin"));
    await user.type(screen.getByLabelText("PIN for Erin"), "5927");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      occurrenceId: OCCURRENCE,
      membershipId: ADULT,
      pin: "5927",
    });
    await waitFor(() => {
      expect(screen.getByLabelText("PIN for Erin")).toHaveValue("");
    });

    fetchMock.mockReturnValueOnce(answer(423, { error: "locked", until: null }));
    await user.type(screen.getByLabelText("PIN for Erin"), "5928");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText("PIN entry is locked. A guardian needs to unlock it."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "That's not me" }));
    expect(screen.getByRole("heading", { name: "Who completed this?" })).toBeInTheDocument();
  });

  it("offers an optional PIN only to someone who has one", async () => {
    const user = userEvent.setup();
    const assigned = { ...chore, assigneeIds: [MIA, NOOR], requiresApproval: true };
    renderWithQuery(<HouseholdChores requirePin={false} members={members} chores={[assigned]} />);
    await user.click(screen.getByRole("button", { name: /Feed the cat/ }));
    await user.click(screen.getByRole("button", { name: "Noor" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("A manager approves this chore after it's done.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "That's not me" }));
    await user.click(screen.getByRole("button", { name: "Mia" }));
    await user.click(screen.getByRole("checkbox", { name: "Confirm with my PIN" }));
    expect(screen.getByLabelText("PIN for Mia")).toHaveFocus();

    fetchMock.mockReturnValueOnce(answer(200, { outcome: "submitted", actionId: ACTION }));
    await user.type(screen.getByLabelText("PIN for Mia"), "4827");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Feed the cat is sent for approval.")).toBeInTheDocument();
  });

  it("says when there is nothing to do", () => {
    renderWithQuery(<HouseholdChores requirePin={false} members={members} chores={[]} />);
    expect(screen.getByText("No open chores for today.")).toBeInTheDocument();
  });
});

describe("SharedDevicePinRule", () => {
  it("saves the rule at once and puts the switch back if that fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, { outcome: "saved" }));
    const { container } = renderWithQuery(
      <SharedDevicePinRule homeId={HOME_ID} requirePin={false} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    const toggle = screen.getByRole("checkbox", { name: /Ask for a PIN/ });
    await user.click(toggle);
    expect(await screen.findByText("PIN rule saved.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/household-devices/pin-rule`);
    expect(bodyOf(init)).toEqual({ requirePin: true });
    expect(toggle).toBeChecked();

    fetchMock.mockReturnValueOnce(answer(403, { error: "not-permitted" }));
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(screen.queryByText("PIN rule saved.")).not.toBeInTheDocument();
  });
});

describe("DevicePinSetting", () => {
  it("refuses an easy PIN locally, sets a good one once and can remove it", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderWithQuery(
      <DevicePinSetting hasPin={false} lockedUntil={null} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText("You have no household-device PIN.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove PIN" })).not.toBeInTheDocument();

    const field = screen.getByLabelText(/New household-device PIN/);
    await user.type(field, "1234");
    await user.click(screen.getByRole("button", { name: "Set PIN" }));
    expect(await screen.findByText(/This PIN is too easy to guess/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockReturnValueOnce(answer(200, { outcome: "saved" }));
    await user.clear(field);
    await user.type(field, "5927");
    await user.click(screen.getByRole("button", { name: "Set PIN" }));
    expect(await screen.findByText("PIN set.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/me/device-pin");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ pin: "5927" });
    expect(field).toHaveValue("");
    expect(container.innerHTML).not.toContain("5927");

    unmount();
    renderWithQuery(<DevicePinSetting hasPin lockedUntil="12 Nov, 15:00" />);
    expect(
      screen.getByText("Locked after too many wrong tries until 12 Nov, 15:00."),
    ).toBeInTheDocument();
    fetchMock.mockReturnValueOnce(answer(200, { outcome: "cleared" }));
    await user.click(screen.getByRole("button", { name: "Remove PIN" }));
    expect(await screen.findByText("PIN removed.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ pin: null });
  });
});
