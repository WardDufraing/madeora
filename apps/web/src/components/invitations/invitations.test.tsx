import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import type { InvitationPreview, JoinRequestView, MyJoinRequestView } from "@/invitations/types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { InvitationList, type InvitationRow } from "./invitation-list";
import { InviteForm } from "./invite-form";
import { JoinCodeForm } from "./join-code-form";
import { JoinInvitation } from "./join-invitation";
import { JoinRequestList } from "./join-request-list";
import { MyJoinRequests } from "./my-join-requests";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const INVITATION_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0004";
const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function inviteForm(
  overrides: Partial<Parameters<typeof InviteForm>[0]> = {},
  locale: "en" | "nl" = "en",
) {
  return renderWithQuery(
    <InviteForm
      homeId={HOME_ID}
      canInviteAdministrators
      emailEnabled
      defaultLanguage="en"
      activeCount={0}
      formats={formats}
      {...overrides}
    />,
    locale,
  );
}

describe("InviteForm", () => {
  it("sends an email invitation with the chosen role and language, and says it went out", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          invitation: {
            id: INVITATION_ID,
            kind: "email",
            expiresAt: "2026-10-21T10:00:00Z",
            url: null,
            code: null,
            delivery: "sent",
          },
        },
        { status: 201 },
      ),
    );
    const user = userEvent.setup();
    inviteForm();
    expect(screen.getByTestId("expiry-preview")).toHaveTextContent(/Valid for 7 days, until/);
    await user.type(screen.getByRole("textbox", { name: /Email address/ }), "Sam@Example.com");
    await user.selectOptions(screen.getByRole("combobox", { name: /Email language/ }), "nl");
    await user.click(screen.getByRole("radio", { name: /Administrator/ }));
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByRole("heading", { name: "Invitation sent to Sam@Example.com." }),
    ).toHaveFocus();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/invitations`);
    expect(bodyOf(init)).toEqual({
      kind: "email",
      role: "administrator",
      email: "Sam@Example.com",
      language: "nl",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("checks the address before sending anything", async () => {
    const user = userEvent.setup();
    inviteForm();
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Enter an email address.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Email address/ }), "nope");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a multi-use link and shows it to copy", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          invitation: {
            id: INVITATION_ID,
            kind: "link",
            expiresAt: "2026-10-15T10:00:00Z",
            url: "https://madeora.example/join/abc",
            code: null,
            delivery: null,
          },
        },
        { status: 201 },
      ),
    );
    const user = userEvent.setup();
    inviteForm();
    await user.click(screen.getByRole("radio", { name: /Invitation link/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Valid for" }), "24h");
    await user.click(screen.getByRole("radio", { name: /Several people/ }));
    const count = screen.getByRole("spinbutton", { name: /Number of people/ });
    await user.clear(count);
    await user.type(count, "11");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Enter a number from 2 to 10.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(count);
    await user.type(count, "4");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect(
      await screen.findByRole("heading", { name: "Invitation link created" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link to share" })).toHaveValue(
      "https://madeora.example/join/abc",
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      kind: "link",
      role: "member",
      expiresIn: "24h",
      maxUses: 4,
    });
  });

  it("offers no role choice to a manager who may not invite Administrators", () => {
    inviteForm({ canInviteAdministrators: false });
    expect(screen.queryByRole("radio", { name: /Administrator/ })).not.toBeInTheDocument();
    expect(screen.getByText("People who join this way become a Member.")).toBeInTheDocument();
  });

  it("offers links and codes only where email isn't set up", () => {
    inviteForm({ emailEnabled: false });
    expect(screen.getByRole("radio", { name: /Email invitation/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Invitation link/ })).toBeChecked();
    expect(screen.getByText(/Email isn't set up here yet/)).toBeInTheDocument();
  });

  it("says when the limit is reached and disables creating", () => {
    inviteForm({ activeCount: 25 });
    expect(screen.getByText(/has 25 active invitations/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  });

  it("keeps the request id when retrying after a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          invitation: {
            id: INVITATION_ID,
            kind: "join_code",
            expiresAt: "2026-10-21T10:00:00Z",
            url: "https://madeora.example/join/ABCDE12345",
            code: "ABCDE-12345",
            delivery: null,
          },
        },
        { status: 201 },
      ),
    );
    const user = userEvent.setup();
    inviteForm();
    await user.click(screen.getByRole("radio", { name: /Join code/ }));
    await user.click(screen.getByRole("button", { name: "Create join code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be reached/);
    await user.click(screen.getByRole("button", { name: "Create join code" }));
    expect(await screen.findByText("ABCDE-12345")).toBeInTheDocument();
    const ids = fetchMock.mock.calls.map(
      ([, init]) => (bodyOf(init) as { requestId: string }).requestId,
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it("uses a new request id when the fields change after a failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    fetchMock.mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    const user = userEvent.setup();
    inviteForm();
    const email = screen.getByRole("textbox", { name: /Email address/ });
    await user.type(email, "a@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be reached/);
    await user.clear(email);
    await user.type(email, "b@example.com");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const ids = fetchMock.mock.calls.map(
      ([, init]) => (bodyOf(init) as { requestId: string }).requestId,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = inviteForm({}, locale);
    expect(await axeViolations(container)).toEqual([]);
  });
});

function invitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION_ID,
    kind: "email",
    role: "member",
    recipientEmail: "sam@example.com",
    emailLanguage: "en",
    state: "active",
    createdAt: "2026-10-14T10:00:00Z",
    expiresAt: "2026-10-21T10:00:00Z",
    endedAt: null,
    maxUses: 1,
    uses: 0,
    pendingRequests: 0,
    delivery: "sent",
    lastSentAt: "2026-10-14T10:00:00Z",
    token: null,
    url: null,
    code: null,
    ...overrides,
  };
}

describe("InvitationList", () => {
  it("shows state, uses and delivery for each invitation", () => {
    renderWithQuery(
      <InvitationList
        homeId={HOME_ID}
        formats={formats}
        invitations={[
          invitation(),
          invitation({
            id: "l",
            kind: "link",
            recipientEmail: null,
            maxUses: 5,
            uses: 2,
            delivery: null,
            url: "https://madeora.example/join/x",
          }),
          invitation({ id: "c", kind: "join_code", state: "expired", maxUses: null, uses: 3 }),
        ]}
      />,
    );
    const [email, link, code] = screen.getAllByTestId("invitation-row");
    if (!email || !link || !code) throw new Error("Expected three rows.");
    expect(within(email).getByText("sam@example.com")).toBeInTheDocument();
    expect(within(email).getByTestId("invitation-delivery")).toHaveTextContent("Sent");
    expect(within(link).getByText("2 of 5 used, 3 left")).toBeInTheDocument();
    expect(within(link).getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(within(code).getByTestId("invitation-state")).toHaveTextContent("Expired");
    expect(within(code).queryByRole("button")).not.toBeInTheDocument();
  });

  it("revokes after confirming", async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 200 }));
    const user = userEvent.setup();
    renderWithQuery(
      <InvitationList homeId={HOME_ID} formats={formats} invitations={[invitation()]} />,
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke this invitation?" });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
    expect(await screen.findByText(/Invitation revoked/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/invitations/${INVITATION_ID}/revoke`,
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("renews after confirming and shows the new expiry in the question", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ delivery: "sent", expiresAt: "2026-10-21T10:00:00Z" }, { status: 200 }),
    );
    const user = userEvent.setup();
    renderWithQuery(
      <InvitationList homeId={HOME_ID} formats={formats} invitations={[invitation()]} />,
    );
    await user.click(screen.getByRole("button", { name: "Renew" }));
    const dialog = screen.getByRole("dialog", { name: "Renew this invitation?" });
    expect(dialog).toHaveAccessibleDescription(/valid until \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    await user.click(within(dialog).getByRole("button", { name: "Renew and send" }));
    expect(await screen.findByText(/New invitation sent to sam@example.com/)).toBeInTheDocument();
  });

  it("explains a refused resend", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "rate-limited" }, { status: 429 }));
    const user = userEvent.setup();
    renderWithQuery(
      <InvitationList homeId={HOME_ID} formats={formats} invitations={[invitation()]} />,
    );
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });

  it("offers no resend once the recipient asked to join", () => {
    renderWithQuery(
      <InvitationList
        homeId={HOME_ID}
        formats={formats}
        invitations={[invitation({ pendingRequests: 1 })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
    expect(screen.getByText("1 request waiting for approval")).toBeInTheDocument();
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = renderWithQuery(
      <InvitationList homeId={HOME_ID} formats={formats} invitations={[invitation()]} />,
      locale,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

function request(overrides: Partial<JoinRequestView> = {}): JoinRequestView {
  return {
    id: REQUEST_ID,
    applicantName: "Sam",
    applicantEmail: "sam@example.com",
    role: "member",
    kind: "link",
    state: "pending",
    createdAt: "2026-10-14T10:00:00Z",
    decidedAt: null,
    canDecide: true,
    ...overrides,
  };
}

describe("JoinRequestList", () => {
  it("approves at once and declines after confirming", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "approved" }, { status: 200 }));
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "declined" }, { status: 200 }));
    const user = userEvent.setup();
    renderWithQuery(<JoinRequestList homeId={HOME_ID} formats={formats} requests={[request()]} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Sam is now a member of this Home.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ decision: "approve" });

    await user.click(screen.getByRole("button", { name: "Decline" }));
    const dialog = screen.getByRole("dialog", { name: "Decline this request?" });
    await user.click(within(dialog).getByRole("button", { name: "Decline request" }));
    expect(await screen.findByText("You declined the request from Sam.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ decision: "decline" });
  });

  it("explains an approval the invitation no longer allows", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "no-longer-valid" }, { status: 409 }));
    const user = userEvent.setup();
    renderWithQuery(<JoinRequestList homeId={HOME_ID} formats={formats} requests={[request()]} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/has ended/);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows no decision buttons for a request only the Owner decides", () => {
    renderWithQuery(
      <JoinRequestList
        homeId={HOME_ID}
        formats={formats}
        requests={[request({ role: "administrator", canDecide: false })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the Owner can decide/)).toBeInTheDocument();
  });

  it("says when nobody is waiting", () => {
    renderWithQuery(<JoinRequestList homeId={HOME_ID} formats={formats} requests={[]} />);
    expect(screen.getByText("No one is waiting for approval.")).toBeInTheDocument();
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = renderWithQuery(
      <JoinRequestList homeId={HOME_ID} formats={formats} requests={[request()]} />,
      locale,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

const okPreview: InvitationPreview = {
  outcome: "ok",
  homeName: "Thuis",
  role: "member",
  kind: "email",
  expiresAt: "2026-10-21T10:00:00Z",
};

describe("JoinInvitation", () => {
  it("shows the Home and role, and asks to join on request", async () => {
    fetchMock.mockResolvedValue(Response.json({ outcome: "requested" }, { status: 200 }));
    const user = userEvent.setup();
    renderWithQuery(<JoinInvitation token="tok" preview={okPreview} formats={formats} />);
    expect(
      screen.getByRole("heading", { name: /You're invited to join .*Thuis/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("join-role")).toHaveTextContent("Member");
    expect(
      screen.getByText(/approves your request before you become a member/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("heading", { name: "Request sent" })).toHaveFocus();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ token: "tok" });
  });

  it("reads the page again when the invitation ended meanwhile", async () => {
    fetchMock.mockResolvedValue(Response.json({ outcome: "revoked" }, { status: 200 }));
    const user = userEvent.setup();
    renderWithQuery(<JoinInvitation token="tok" preview={okPreview} formats={formats} />);
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("uses the join-code wording for codes", () => {
    renderWithQuery(
      <JoinInvitation
        token="tok"
        preview={{ ...okPreview, kind: "join_code" }}
        formats={formats}
      />,
    );
    expect(screen.getByRole("button", { name: "Ask to join" })).toBeInTheDocument();
  });

  it.each([
    [{ outcome: "expired" }, "This invitation has expired"],
    [{ outcome: "revoked" }, "This invitation was withdrawn"],
    [{ outcome: "used_up" }, "This invitation has been used"],
    [{ outcome: "invalid" }, "This link or code doesn't work"],
    [{ outcome: "declined" }, "Your request was declined"],
    [{ outcome: "rate_limited" }, "Too many attempts"],
    [{ outcome: "pending", homeName: "Thuis" }, "Your request is waiting"],
    [{ outcome: "already_member", homeId: HOME_ID, homeName: "Thuis" }, "You're already a member"],
  ] as const)("explains %o", (preview, heading) => {
    renderWithQuery(<JoinInvitation token="tok" preview={preview} formats={formats} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept|Ask to join/ })).not.toBeInTheDocument();
  });

  it("refuses a forwarded email invitation without showing any address, and offers sign-out", () => {
    renderWithQuery(
      <JoinInvitation token="tok" preview={{ outcome: "email_mismatch" }} formats={formats} />,
    );
    expect(screen.getByRole("heading", { name: /for another account/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = renderWithQuery(
      <JoinInvitation token="tok" preview={okPreview} formats={formats} />,
      locale,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("JoinCodeForm", () => {
  it("opens the join page for a typed code, compacted", async () => {
    const user = userEvent.setup();
    renderWithQuery(<JoinCodeForm />);
    await user.type(screen.getByRole("textbox", { name: /Join code/ }), " abcde-12345 ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/join/ABCDE12345");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses something that is not a code", async () => {
    const user = userEvent.setup();
    renderWithQuery(<JoinCodeForm />);
    await user.type(screen.getByRole("textbox", { name: /Join code/ }), "abc");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("A join code has 10 letters and numbers.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = renderWithQuery(<JoinCodeForm />, locale);
    expect(await axeViolations(container)).toEqual([]);
  });
});

function mine(overrides: Partial<MyJoinRequestView> = {}): MyJoinRequestView {
  return {
    id: REQUEST_ID,
    homeId: null,
    homeName: "Thuis",
    role: "member",
    kind: "invitation",
    state: "pending",
    createdAt: "2026-10-14T10:00:00Z",
    decidedAt: null,
    ...overrides,
  };
}

describe("MyJoinRequests", () => {
  it("lists states and withdraws a pending request", async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 200 }));
    const user = userEvent.setup();
    renderWithQuery(
      <MyJoinRequests
        formats={formats}
        requests={[
          mine(),
          mine({ id: "b", state: "approved", homeId: HOME_ID, homeName: "Kot" }),
          mine({ id: "c", state: "declined", homeName: "Elders" }),
        ]}
      />,
    );
    const states = screen.getAllByTestId("my-join-request-state").map((node) => node.textContent);
    expect(states).toEqual(["Waiting for approval", "Approved", "Declined"]);
    expect(screen.getByRole("link", { name: "Kot" })).toHaveAttribute("href", `/homes/${HOME_ID}`);
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Request withdrawn.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/join-requests/${REQUEST_ID}/withdraw`);
  });

  it("says when there are none", () => {
    renderWithQuery(<MyJoinRequests formats={formats} requests={[]} />);
    expect(screen.getByText(/haven't asked to join/)).toBeInTheDocument();
  });

  it.each(["en", "nl"] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = renderWithQuery(
      <MyJoinRequests formats={formats} requests={[mine()]} />,
      locale,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
