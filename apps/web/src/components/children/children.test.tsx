import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { AddChildForm } from "./add-child-form";
import { ChildAccessForm } from "./child-access-form";
import { ChildGuardians } from "./child-guardians";
import { DeleteMistakenChild } from "./delete-mistaken-child";
import { GuardianOffers } from "./guardian-offers";
import { LinkChildForm } from "./link-child-form";
import { LinkCodeCard } from "./link-code-card";
import { RemoveChild } from "./remove-child";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SELF_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const OTHER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const CHILD_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const UPDATED_AT = "2026-11-12T08:00:00.000Z";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

describe("AddChildForm", () => {
  it("needs only a name and creates the child with the caller as guardian", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(201, { child: { membershipId: CHILD_ID } }));
    const { container } = renderWithQuery(
      <AddChildForm
        homeId={HOME_ID}
        guardianOptions={[{ membershipId: SELF_ID, name: "Bob" }]}
        defaultGuardianMembershipId={SELF_ID}
        suggestedColor="#16a34a"
      />,
    );
    expect(screen.getByTestId("primary-guardian-self")).toHaveTextContent(
      "You will be the child's primary guardian.",
    );
    expect(screen.queryByRole("textbox", { name: /email/i })).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Add child" }));
    expect(await screen.findByText("Enter a name.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Mia");
    await user.selectOptions(screen.getByRole("combobox", { name: /Age range/ }), "13_17");
    expect(screen.getByTestId("preset-suggestion")).toHaveTextContent("Suggested for later: Teen");
    await user.click(screen.getByRole("button", { name: "Add child" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}/children/${CHILD_ID}?created=1`);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/children`);
    expect(bodyOf(init)).toMatchObject({
      name: "Mia",
      primaryGuardianMembershipId: SELF_ID,
      ageBand: "13_17",
      accentColor: "#16a34a",
    });
  });

  it("lets a manager choose another adult and reports a refused guardian", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "invalid-guardian" }));
    renderWithQuery(
      <AddChildForm
        homeId={HOME_ID}
        guardianOptions={[
          { membershipId: SELF_ID, name: "Alice" },
          { membershipId: OTHER_ID, name: "Dave" },
        ]}
        defaultGuardianMembershipId={SELF_ID}
        suggestedColor="#16a34a"
      />,
      "nl",
    );
    await user.type(screen.getByRole("textbox", { name: "Naam" }), "Noor");
    await user.selectOptions(screen.getByRole("combobox", { name: "Hoofdvoogd" }), OTHER_ID);
    await user.click(screen.getByRole("button", { name: "Kind toevoegen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("kan hier geen voogd zijn");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      primaryGuardianMembershipId: OTHER_ID,
      ageBand: null,
    });
  });
});

describe("ChildAccessForm", () => {
  function renderAccess(guardianRole: "primary" | "secondary") {
    return renderWithQuery(
      <ChildAccessForm
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        guardianRole={guardianRole}
        preset="young_child"
        overrides={{}}
        updatedAt={UPDATED_AT}
      />,
    );
  }

  it("previews a wider preset and asks for confirmation before saving", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "saved", before: [], after: [] }));
    const { container } = renderAccess("primary");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("radio", { name: /^Teen/ }));
    expect(screen.getByTestId("access-preview")).toHaveTextContent("Added: Add to shopping lists");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    const dialog = screen.getByRole("dialog", { name: "Give Mia more access?" });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Yes, save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      preset: "teen",
      overrides: {},
      confirmExpansion: true,
      expectedUpdatedAt: UPDATED_AT,
    });
  });

  it("saves a restriction without confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "saved", before: [], after: [] }));
    renderAccess("primary");
    await user.click(screen.getByRole("checkbox", { name: "See the points leaderboard" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      overrides: { viewLeaderboard: false },
      confirmExpansion: false,
    });
  });

  it("lets a secondary guardian only switch things off", () => {
    renderAccess("secondary");
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Add to shopping lists" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "See the points leaderboard" })).toBeEnabled();
    expect(
      screen.getByText("Only the primary guardian can change the preset."),
    ).toBeInTheDocument();
  });
});

describe("ChildGuardians", () => {
  it("shows a child on hold and lets the Owner ask another adult to be primary", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "offered" }));
    const { container } = renderWithQuery(
      <ChildGuardians
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        primaryName={null}
        secondaryName={null}
        hasSecondary={false}
        pendingPrimaryName={null}
        pendingSecondaryName={null}
        pendingPrimaryOfferId={null}
        pendingSecondaryOfferId={null}
        candidates={[{ membershipId: OTHER_ID, name: "Bob" }]}
        canAssignSecondary={false}
        canHandOverPrimary={false}
        canAppointPrimary
        canRemoveSecondary={false}
        isSecondary={false}
      />,
    );
    expect(screen.getByTestId("primary-guardian")).toHaveTextContent("None (on hold)");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Ask to be primary guardian" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/children/${CHILD_ID}/guardians`);
    expect(bodyOf(init)).toEqual({ role: "primary", guardianMembershipId: OTHER_ID });
    expect(await screen.findByRole("status")).toHaveTextContent("It applies once they accept.");
  });

  it("offers nothing to change to a member who is not a guardian", () => {
    renderWithQuery(
      <ChildGuardians
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        primaryName="Bob"
        secondaryName="Dave"
        hasSecondary
        pendingPrimaryName="Erin"
        pendingSecondaryName={null}
        pendingPrimaryOfferId={null}
        pendingSecondaryOfferId={null}
        candidates={[{ membershipId: OTHER_ID, name: "Carol" }]}
        canAssignSecondary={false}
        canHandOverPrimary={false}
        canAppointPrimary={false}
        canRemoveSecondary={false}
        isSecondary={false}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTestId("secondary-guardian")).toHaveTextContent("Dave");
    expect(screen.getByTestId("pending-guardians")).toHaveTextContent(
      "Waiting for Erin to accept the primary role.",
    );
  });
});

describe("RemoveChild", () => {
  it("explains a child's only Home cannot be removed", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(409, { error: "child-last-home" }));
    renderWithQuery(
      <RemoveChild homeId={HOME_ID} homeName="Thuis" membershipId={CHILD_ID} childName="Mia" />,
    );
    await user.click(screen.getByRole("button", { name: "Remove Mia from this Home" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Mia from Thuis?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only Home");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("GuardianOffers", () => {
  it("lets the named adult accept", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "accepted" }));
    const OFFER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
    const { container } = renderWithQuery(
      <GuardianOffers
        homeId={HOME_ID}
        offers={[{ offerId: OFFER_ID, childName: "Noor", role: "primary", expires: "26/11/2026" }]}
      />,
    );
    expect(screen.getByTestId("guardian-offers")).toHaveTextContent(
      "You're asked to be the primary guardian of Noor.",
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You're now a guardian of Noor.");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/children/offers/${OFFER_ID}`);
    expect(bodyOf(init)).toEqual({ action: "accept" });
  });

  it("renders nothing when there are no offers", () => {
    const { container } = renderWithQuery(<GuardianOffers homeId={HOME_ID} offers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("DeleteMistakenChild", () => {
  it("confirms, then deletes and returns to the members page", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    renderWithQuery(
      <DeleteMistakenChild homeId={HOME_ID} membershipId={CHILD_ID} childName="Mai" />,
    );
    await user.click(screen.getByRole("button", { name: "Delete Mai" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Mai completely?" });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}/members?childDeleted=1`);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/children/${CHILD_ID}/delete`,
    );
  });
});

describe("LinkCodeCard", () => {
  it("creates a one-time code and shows it once", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(
      answer(200, { code: "ABCD-EFGH-JKMN-PQRS", expiresAt: "2026-11-19T08:00:00.000Z" }),
    );
    const { container } = renderWithQuery(
      <LinkCodeCard homeId={HOME_ID} membershipId={CHILD_ID} childName="Mai" openUntil={null} />,
    );
    expect(screen.queryByRole("button", { name: "Withdraw code" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create link code" }));
    expect(await screen.findByTestId("link-code")).toHaveTextContent("ABCD-EFGH-JKMN-PQRS");
    expect(await axeViolations(container)).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/children/${CHILD_ID}/link-code`);
    expect(bodyOf(init)).toEqual({ action: "issue" });
  });

  it("withdraws an open code", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, {}));
    renderWithQuery(
      <LinkCodeCard
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mai"
        openUntil="19/11/2026"
      />,
    );
    expect(screen.getByText("A code is open until 19/11/2026.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Withdraw code" }));
    expect(await screen.findByText("Code withdrawn.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ action: "cancel" });
  });
});

describe("LinkChildForm", () => {
  it("rejects a malformed code without calling the server", async () => {
    const user = userEvent.setup();
    renderWithQuery(<LinkChildForm homeId={HOME_ID} suggestedColor="#16a34a" />);
    await user.type(screen.getByLabelText("Link code"), "ABC");
    await user.click(screen.getByRole("button", { name: "Link child" }));
    expect(await screen.findByText(/Enter the 16-character code/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redeems the code and opens the child's page", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(201, { child: { membershipId: CHILD_ID } }));
    const { container } = renderWithQuery(
      <LinkChildForm homeId={HOME_ID} suggestedColor="#16a34a" />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.type(screen.getByLabelText("Link code"), "abcd-efgh-jkmn-pqrs");
    await user.click(screen.getByRole("button", { name: "Link child" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}/children/${CHILD_ID}?linked=1`);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/children/link`);
    expect(bodyOf(init)).toMatchObject({ code: "abcd-efgh-jkmn-pqrs" });
  });

  it("shows when the code isn't valid", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(404, { error: "invalid-code" }));
    renderWithQuery(<LinkChildForm homeId={HOME_ID} suggestedColor="#16a34a" />);
    await user.type(screen.getByLabelText("Link code"), "ABCDEFGHJKMNPQRS");
    await user.click(screen.getByRole("button", { name: "Link child" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't valid.");
    expect(router.push).not.toHaveBeenCalled();
  });
});
