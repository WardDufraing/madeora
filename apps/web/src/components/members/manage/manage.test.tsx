import type { DelegableCapability, HomeMembershipFacts } from "@madeora/domain/permissions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import { axeViolations } from "@/test/axe";
import { dictionaries, renderWithIntl, renderWithQuery } from "@/test/intl";

import { CapabilitiesForm } from "./capabilities-form";
import { LeaveHome } from "./leave-home";
import { MemberRoleForm } from "./member-role-form";
import { NominateOwner } from "./nominate-owner";
import { OwnershipTransferBanner } from "./ownership-transfer-banner";
import { RemoveMember } from "./remove-member";
import { YourPermissions } from "./your-permissions";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const MEMBER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const TRANSFER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
});

describe("MemberRoleForm", () => {
  function renderForm(locale: "en" | "nl" = "en") {
    return renderWithQuery(
      <MemberRoleForm
        homeId={HOME_ID}
        homeName="Thuis"
        membershipId={MEMBER_ID}
        memberName="Sam"
        currentRole="member"
      />,
      locale,
    );
  }

  it("asks before promoting, then sends the role the Owner saw", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { role: "administrator" }));
    const { container } = renderForm();
    const save = screen.getByRole("button", { name: "Change role" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Administrator" }));
    await user.click(save);
    const dialog = screen.getByRole("dialog", { name: "Change Sam's role?" });
    expect(dialog).toHaveTextContent("with no management rights until you grant them");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Change role" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Sam is now Administrator.");
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/members/${MEMBER_ID}`);
    expect(init?.method).toBe("PATCH");
    expect(bodyOf(init)).toEqual({ role: "administrator", expectedRole: "member" });
    expect(router.refresh).toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains a refusal caused by a change made meanwhile", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "stale" }));
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Administrator" }));
    await user.click(screen.getByRole("button", { name: "Change role" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Change role" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Something changed in the meantime");
  });

  it("is translated into Dutch", () => {
    renderForm("nl");
    expect(screen.getByRole("radio", { name: "Beheerder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rol wijzigen" })).toBeInTheDocument();
  });
});

describe("CapabilitiesForm", () => {
  it("previews what saving grants and takes away, and confirms both", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { capabilities: ["removeMembers"] }));
    const { container } = renderWithQuery(
      <CapabilitiesForm
        homeId={HOME_ID}
        membershipId={MEMBER_ID}
        memberName="Sam"
        granted={["manageInvitations"]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Manage invitations/ })).toBeChecked();
    expect(screen.getByTestId("capabilities-preview")).toHaveTextContent("No changes yet.");
    await user.click(screen.getByRole("checkbox", { name: /Manage invitations/ }));
    await user.click(screen.getByRole("checkbox", { name: /Remove members/ }));
    expect(screen.getByTestId("capabilities-preview")).toHaveTextContent(
      "If you save: Remove members granted, Manage invitations taken away.",
    );
    await user.click(screen.getByRole("button", { name: "Save rights" }));
    const dialog = screen.getByRole("dialog", { name: "Change Sam's rights?" });
    expect(dialog).toHaveTextContent("Granted: Remove members");
    expect(dialog).toHaveTextContent("Taken away at once: Manage invitations");
    await user.click(within(dialog).getByRole("button", { name: "Save rights" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Sam's rights are saved.");
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/members/${MEMBER_ID}/capabilities`);
    expect(init?.method).toBe("PUT");
    expect(bodyOf(init)).toEqual({ capabilities: ["removeMembers"] });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps the saved message when the page refreshes with the new rights, and follows later changes", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { capabilities: ["removeMembers"] }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const form = (granted: DelegableCapability[]) => (
      <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
        <QueryClientProvider client={client}>
          <CapabilitiesForm
            homeId={HOME_ID}
            membershipId={MEMBER_ID}
            memberName="Sam"
            granted={granted}
          />
        </QueryClientProvider>
      </NextIntlClientProvider>
    );
    const { rerender } = render(form([]));
    await user.click(screen.getByRole("checkbox", { name: /Remove members/ }));
    await user.click(screen.getByRole("button", { name: "Save rights" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save rights" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Sam's rights are saved.");
    });
    // router.refresh() brings the saved rights back from the server.
    rerender(form(["removeMembers"]));
    expect(screen.getByRole("status")).toHaveTextContent("Sam's rights are saved.");
    expect(screen.getByTestId("capabilities-preview")).toHaveTextContent("No changes yet.");
    // A later refresh with a change made elsewhere starts the choice again from it.
    rerender(form(["manageHomeSettings"]));
    expect(screen.getByRole("checkbox", { name: /Manage Home settings/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Remove members/ })).not.toBeChecked();
    expect(screen.getByTestId("capabilities-preview")).toHaveTextContent("No changes yet.");
  });

  it("explains what each right allows", () => {
    renderWithQuery(
      <CapabilitiesForm homeId={HOME_ID} membershipId={MEMBER_ID} memberName="Sam" granted={[]} />,
    );
    expect(screen.getByRole("checkbox", { name: /Remove members/ })).toHaveAccessibleDescription(
      "Remove Members from the Home. Never other Administrators or the Owner.",
    );
  });
});

describe("RemoveMember", () => {
  it("names the person and Home, lists the consequences and removes after confirming", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    const { container } = renderWithQuery(
      <RemoveMember
        homeId={HOME_ID}
        homeName="Thuis"
        membershipId={MEMBER_ID}
        memberName="Sam"
        currentRole="administrator"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Sam from Thuis?" });
    expect(dialog).toHaveTextContent("Sam loses access to this Home at once, on every device.");
    expect(dialog).toHaveTextContent("Invitations they created stop working.");
    expect(dialog).toHaveTextContent("Things that belong to the Home stay in the Home.");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}/members?removed=1`);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ expectedRole: "administrator" });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <RemoveMember
        homeId={HOME_ID}
        homeName="Thuis"
        membershipId={MEMBER_ID}
        memberName="Sam"
        currentRole="member"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Invitations they created");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports someone already removed", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(404, { error: "not-found" }));
    renderWithQuery(
      <RemoveMember
        homeId={HOME_ID}
        homeName="Thuis"
        membershipId={MEMBER_ID}
        memberName="Sam"
        currentRole="member"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove Sam" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This member or request isn't in this Home any more.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("NominateOwner", () => {
  it("explains that nothing changes until they accept, with one request id per confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(201, { transfer: { id: TRANSFER_ID } }));
    renderWithQuery(
      <NominateOwner homeId={HOME_ID} homeName="Thuis" membershipId={MEMBER_ID} memberName="Sam" />,
    );
    await user.click(screen.getByRole("button", { name: "Ask Sam to become Owner" }));
    const dialog = screen.getByRole("dialog", { name: "Ask Sam to become the Owner of Thuis?" });
    expect(dialog).toHaveTextContent("Nothing changes until they accept.");
    await user.click(within(dialog).getByRole("button", { name: "Send request" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}`);
    });
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]) as {
      membershipId: string;
      requestId: string;
    };
    expect(body.membershipId).toBe(MEMBER_ID);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("OwnershipTransferBanner", () => {
  it("lets the nominated member accept after a confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "accepted" }));
    const { container } = renderWithQuery(
      <OwnershipTransferBanner
        homeId={HOME_ID}
        homeName="Thuis"
        transferId={TRANSFER_ID}
        viewer="recipient"
        otherName="Alice"
        expiresLabel="22/10/2026 10:00"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "You've been asked to become the Owner of Thuis" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ownership-transfer-banner")).toHaveTextContent("22/10/2026 10:00");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Accept and become Owner" }));
    const dialog = screen.getByRole("dialog", { name: "Become the Owner of Thuis?" });
    await user.click(within(dialog).getByRole("button", { name: "Become Owner" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You are now the Owner of Thuis.");
    expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}?transfer=accepted`, {
      scroll: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/ownership-transfers/${TRANSFER_ID}/accept`,
    );
  });

  it("lets the recipient decline at once", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "declined" }));
    renderWithQuery(
      <OwnershipTransferBanner
        homeId={HOME_ID}
        homeName="Thuis"
        transferId={TRANSFER_ID}
        viewer="recipient"
        otherName="Alice"
        expiresLabel="22/10/2026 10:00"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You declined. Nothing changed.");
    expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}?transfer=declined`, {
      scroll: false,
    });
  });

  it("shows the Owner who is waiting and lets them cancel", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "cancelled" }));
    renderWithQuery(
      <OwnershipTransferBanner
        homeId={HOME_ID}
        homeName="Thuis"
        transferId={TRANSFER_ID}
        viewer="sender"
        otherName="Sam"
        expiresLabel="22/10/2026 10:00"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Waiting for Sam to accept ownership" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept and become Owner" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The request was cancelled. You're still the Owner.",
    );
    expect(router.replace).toHaveBeenCalledWith(`/homes/${HOME_ID}?transfer=cancelled`, {
      scroll: false,
    });
  });

  it("explains an expired request", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "expired" }));
    renderWithQuery(
      <OwnershipTransferBanner
        homeId={HOME_ID}
        homeName="Thuis"
        transferId={TRANSFER_ID}
        viewer="recipient"
        otherName="Alice"
        expiresLabel="22/10/2026 10:00"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request has expired.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("LeaveHome", () => {
  it("leaves after a confirmation and opens the personal space", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    const { container } = renderWithQuery(<LeaveHome homeId={HOME_ID} homeName="Thuis" />);
    await user.click(screen.getByRole("button", { name: "Leave Thuis" }));
    const dialog = screen.getByRole("dialog", { name: "Leave Thuis?" });
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/?notice=home-left");
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/homes/${HOME_ID}/leave`);
  });

  it("tells an Owner to hand over ownership first", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "owner-must-transfer" }));
    renderWithQuery(<LeaveHome homeId={HOME_ID} homeName="Thuis" />);
    await user.click(screen.getByRole("button", { name: "Leave Thuis" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "As the Owner you can't leave until someone else has accepted ownership.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("YourPermissions", () => {
  const facts = (
    role: HomeMembershipFacts["role"],
    granted: HomeMembershipFacts["grantedCapabilities"] = new Set(),
  ): HomeMembershipFacts => ({ homeId: HOME_ID, role, grantedCapabilities: granted });

  it("lists an Administrator's granted rights with what they allow", async () => {
    const { container } = renderWithIntl(
      <YourPermissions membership={facts("administrator", new Set(["removeMembers"]))} />,
    );
    const section = screen.getByTestId("your-permissions");
    expect(section).toHaveTextContent("The Owner gave you these rights:");
    expect(section).toHaveTextContent("Remove members");
    expect(section).not.toHaveTextContent("Manage invitations");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when an Administrator has no rights yet, and describes Owners and Members", () => {
    const first = renderWithIntl(<YourPermissions membership={facts("administrator")} />);
    expect(screen.getByTestId("your-permissions")).toHaveTextContent(
      "hasn't given you any management rights yet",
    );
    first.unmount();
    const second = renderWithIntl(<YourPermissions membership={facts("member")} />);
    expect(screen.getByTestId("your-permissions")).toHaveTextContent("You're a Member");
    second.unmount();
    renderWithIntl(<YourPermissions membership={facts("owner")} />);
    expect(screen.getByTestId("your-permissions")).toHaveTextContent("You're the Owner");
  });
});
