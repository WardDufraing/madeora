import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import type { DirectoryMember } from "@/members/directory-view";
import {
  arrangeDirectory,
  nameCollator,
  parseDirectoryQuery,
  sharedNameIds,
} from "@/members/directory-view";
import { axeViolations } from "@/test/axe";
import { dictionaries, renderWithQuery } from "@/test/intl";

import { HomeProfileForm, type HomeProfileFormProps } from "./home-profile-form";
import { MemberDirectory } from "./member-directory";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Members" }),
      ),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function profileForm(overrides: Partial<HomeProfileFormProps> = {}) {
  return (
    <HomeProfileForm
      homeId={HOME_ID}
      homeName="Thuis"
      homeRole="member"
      globalName="Alice"
      globalAccent={null}
      overrides={{ nickname: null, displayName: null, accentColor: null }}
      otherColors={["#16a34a"]}
      {...overrides}
    />
  );
}

function respondWith(profile: Record<string, unknown>) {
  fetchMock.mockResolvedValue(Response.json({ profile }, { status: 200 }));
}

describe("HomeProfileForm", () => {
  it("shows the inherited global name and previews a nickname before saving it", async () => {
    respondWith({ nickname: "Ali", displayName: null, accentColor: null });
    const user = userEvent.setup();
    const { container } = renderWithQuery(profileForm());
    const preview = screen.getByTestId("profile-preview");
    expect(within(preview).getByText("Alice")).toBeInTheDocument();
    expect(screen.getByTestId("name-source")).toHaveTextContent("global display name");
    expect(screen.getByText(/Now using your global display name/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /Nickname/ }), "  Ali ");
    expect(within(preview).getByText("Ali")).toBeInTheDocument();
    expect(screen.getByTestId("name-source")).toHaveTextContent("nickname");

    await user.click(
      within(screen.getByTestId("nickname-form")).getByRole("button", { name: "Save" }),
    );
    expect(await screen.findByText("Nickname saved.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/profile`);
    expect(init?.method).toBe("PATCH");
    expect(bodyOf(init)).toEqual({ nickname: "Ali" });
    expect(router.refresh).toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("refuses an invisible nickname without sending anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(profileForm());
    await user.type(screen.getByRole("textbox", { name: /Nickname/ }), "Al\u{200B}i");
    await user.click(
      within(screen.getByTestId("nickname-form")).getByRole("button", { name: "Save" }),
    );
    expect(
      await screen.findByText(/no invisible or text-direction characters/),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resets the Home display name on its own, leaving the nickname alone", async () => {
    respondWith({ nickname: "Ali", displayName: null, accentColor: null });
    const user = userEvent.setup();
    renderWithQuery(
      profileForm({ overrides: { nickname: "Ali", displayName: "Alice B", accentColor: null } }),
    );
    await user.click(screen.getByRole("button", { name: "Use global display name" }));
    expect(
      await screen.findByText("This Home uses your global display name again."),
    ).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ displayName: null });
  });

  it("warns about a colour another member has, suggests others, and still saves it", async () => {
    respondWith({ nickname: null, displayName: null, accentColor: "#16a34a" });
    const user = userEvent.setup();
    const { container } = renderWithQuery(profileForm());
    expect(screen.queryByTestId("colour-clash")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Use a different colour in this Home" }));
    await user.click(screen.getByRole("radio", { name: "Green" }));
    expect(screen.getByTestId("colour-clash")).toHaveTextContent("same colour");
    expect(screen.getAllByRole("button", { name: /^Use / }).length).toBeGreaterThan(0);
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Save colour" }));
    expect(await screen.findByText("Colour for this Home saved.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: "#16a34a" });
  });

  it("applies a suggested colour, and goes back to the global colour with null", async () => {
    respondWith({ nickname: null, displayName: null, accentColor: null });
    const user = userEvent.setup();
    renderWithQuery(profileForm({ otherColors: ["#8057f5"] }));
    // The default colour clashes with a member who also has the default.
    expect(screen.getByTestId("colour-clash")).toHaveTextContent("same colour");
    await user.click(screen.getAllByRole("button", { name: /^Use / })[0] as HTMLElement);
    expect(screen.queryByTestId("colour-clash")).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Use a different colour in this Home" }),
    ).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Use my global accent colour" }));
    await user.click(screen.getByRole("button", { name: "Save colour" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: null });
    });
  });

  it("explains a Home that is no longer available", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "not-found" }, { status: 404 }));
    const user = userEvent.setup();
    renderWithQuery(profileForm());
    await user.type(screen.getByRole("textbox", { name: /Nickname/ }), "Ali");
    await user.click(
      within(screen.getByTestId("nickname-form")).getByRole("button", { name: "Save" }),
    );
    expect(
      await screen.findByText("This Home isn't available to you any more."),
    ).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('keeps "Your own colour" chosen when picked from a palette colour', async () => {
    respondWith({ nickname: null, displayName: null, accentColor: "#2563eb" });
    const user = userEvent.setup();
    renderWithQuery(profileForm({ globalAccent: "#2563eb" }));
    await user.click(screen.getByRole("radio", { name: "Use a different colour in this Home" }));
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Your own colour" }));
    expect(screen.getByRole("radio", { name: "Your own colour" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Blue" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Hex code" })).toHaveValue("#2563eb");
    await user.click(screen.getByRole("radio", { name: "Green" }));
    expect(screen.getByRole("radio", { name: "Your own colour" })).not.toBeChecked();
  });

  it("picks a custom colour with the hex field", async () => {
    respondWith({ nickname: null, displayName: null, accentColor: "#123abc" });
    const user = userEvent.setup();
    renderWithQuery(profileForm());
    await user.click(screen.getByRole("radio", { name: "Use a different colour in this Home" }));
    const hex = screen.getByRole("textbox", { name: "Hex code" });
    await user.clear(hex);
    await user.type(hex, "#123ABC");
    expect(screen.getByRole("radio", { name: "Your own colour" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save colour" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ accentColor: "#123abc" });
    });
  });
});

const formats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;

function member(
  id: string,
  role: DirectoryMember["role"],
  name: string | null,
  joinedAt: string,
  extra: Partial<DirectoryMember> = {},
): DirectoryMember {
  return { membershipId: id, role, name, joinedAt, isSelf: false, accentColor: null, ...extra };
}

const members = [
  member("m1", "owner", "Bram", "2026-10-01T08:00:00Z", { accentColor: "#2563eb" }),
  member("m2", "member", "Alex", "2026-10-02T08:00:00Z", { isSelf: true, accentColor: "#2563eb" }),
  member("m3", "member", "alex", "2026-10-03T08:00:00Z", { accentColor: "#2563eb" }),
  member("m4", "administrator", null, "2026-10-04T08:00:00Z"),
];

async function renderDirectory(
  params: { sort?: string; role?: string | string[] } = {},
  manageable: ReadonlySet<string> = new Set(),
) {
  const query = parseDirectoryQuery(params);
  const collator = nameCollator("en");
  const ui = await MemberDirectory({
    homeId: HOME_ID,
    shown: arrangeDirectory(members, query, collator),
    all: members,
    total: members.length,
    query,
    sharedNames: sharedNameIds(members, collator),
    manageable,
    formats,
  });
  return render(
    <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("MemberDirectory", () => {
  it("keeps a member's qualifier the same whatever the filter", async () => {
    const twins = [
      member("a", "owner", "Sam", "2026-10-01T08:00:00Z"),
      member("b", "member", "Sam", "2026-10-01T09:30:00Z"),
    ];
    const query = parseDirectoryQuery({ role: "member" });
    const collator = nameCollator("en");
    const ui = await MemberDirectory({
      homeId: HOME_ID,
      shown: arrangeDirectory(twins, query, collator),
      all: twins,
      total: 2,
      query,
      sharedNames: sharedNameIds(twins, collator),
      manageable: new Set(),
      formats,
    });
    render(
      <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId("member-qualifier")).toHaveTextContent("joined 01/10/2026 11:30");
  });

  it("lists every member with name, role and a qualifier for shared names", async () => {
    const { container } = await renderDirectory();
    const rows = screen.getAllByTestId("directory-member");
    expect(rows.map((row) => within(row).getByTestId("member-name").textContent)).toEqual([
      "Bram",
      "Member without a name",
      "Alex (you)",
      "alex",
    ]);
    expect(screen.getByTestId("member-count")).toHaveTextContent("4 members");
    // Two people called Alex with the same colour are told apart by the date they joined.
    expect(within(rows[2] as HTMLElement).getByTestId("member-qualifier")).toHaveTextContent(
      "joined 02/10/2026",
    );
    expect(within(rows[3] as HTMLElement).getByTestId("member-qualifier")).toHaveTextContent(
      "joined 03/10/2026",
    );
    expect(within(rows[0] as HTMLElement).queryByTestId("member-qualifier")).toBeNull();
    // Only your own row links to editing, and nobody else's has an action.
    expect(screen.getAllByRole("link", { name: "Edit how you appear" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Show everyone" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("links the members the viewer may manage to their page (S12)", async () => {
    const { container } = await renderDirectory({}, new Set(["m3", "m4"]));
    const links = screen.getAllByTestId("manage-member-link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/homes/${HOME_ID}/members/m4`,
      `/homes/${HOME_ID}/members/m3`,
    ]);
    // Each link names the member for screen readers, so "Manage" is never ambiguous.
    expect(screen.getByRole("link", { name: "Manage: alex" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage: Member without a name" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("filters by role with a count, and offers a way back", async () => {
    await renderDirectory({ role: "member", sort: "name" });
    expect(screen.getAllByTestId("directory-member")).toHaveLength(2);
    expect(screen.getByTestId("member-count")).toHaveTextContent("Showing 2 of 4 members");
    expect(screen.getByRole("checkbox", { name: "Member" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveValue("name");
    expect(screen.getByRole("link", { name: "Show everyone" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/members`,
    );
  });

  it("says so when no member matches", async () => {
    const query = parseDirectoryQuery({ role: "administrator" });
    const ui = await MemberDirectory({
      homeId: HOME_ID,
      shown: [],
      all: members,
      total: 4,
      query,
      sharedNames: new Set(),
      manageable: new Set(),
      formats,
    });
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("No members match")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("adds the time when two people with the same name joined on the same day", async () => {
    const twins = [
      member("a", "owner", "Sam", "2026-10-01T08:00:00Z"),
      member("b", "member", "Sam", "2026-10-01T09:30:00Z"),
    ];
    const query = parseDirectoryQuery({});
    const ui = await MemberDirectory({
      homeId: HOME_ID,
      shown: twins,
      all: twins,
      total: 2,
      query,
      sharedNames: sharedNameIds(twins, nameCollator("en")),
      manageable: new Set(),
      formats,
    });
    render(
      <NextIntlClientProvider locale="en" messages={dictionaries.en} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByTestId("member-qualifier").map((q) => q.textContent)).toEqual([
      " · joined 01/10/2026 10:00",
      " · joined 01/10/2026 11:30",
    ]);
  });
});
