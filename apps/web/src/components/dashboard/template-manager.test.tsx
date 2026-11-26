import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

import type { LayoutPreview } from "@/dashboard/preview";
import type { WidgetType } from "@/dashboard/widgets";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TemplateManager, type ManagedTemplate, type TemplateHome } from "./template-manager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock: Mock<typeof fetch> = vi.fn();
const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const MINE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0100";
const HOME_KIND = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0101";
const SHARED = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0102";

/** A preview with the widgets stacked, each 6 by 2 on desktop and 1 by 2 on a phone. */
function previewOf(types: readonly WidgetType[]): LayoutPreview {
  const widgets = types.map((type, index) => ({ id: `w${String(index)}`, type, hidden: false }));
  const place = (w: number) =>
    widgets.map((widget, i) => ({ id: widget.id, x: 0, y: i * 2, w, h: 2 }));
  return { widgets, placements: { lg: place(6), md: place(6), sm: place(1) } };
}

const homes: TemplateHome[] = [
  { id: HOME_A, name: "Thuis", canEditDashboard: true },
  { id: HOME_B, name: "Cabin", canEditDashboard: false },
];
const templates: ManagedTemplate[] = [
  {
    id: MINE,
    name: "Mornings",
    kind: "personal",
    widgets: ["welcome", "notifications"],
    isMine: true,
    sharedHomeIds: [],
    preview: previewOf(["welcome", "notifications"]),
  },
  {
    id: HOME_KIND,
    name: "Family board",
    kind: "home",
    widgets: ["home-members"],
    isMine: true,
    sharedHomeIds: [],
    preview: previewOf(["home-members"]),
  },
  {
    id: SHARED,
    name: "Weekend",
    kind: "personal",
    widgets: ["quick-actions"],
    isMine: false,
    sharedHomeIds: [HOME_A, HOME_B],
    preview: previewOf(["quick-actions"]),
  },
];

function ok(body = "{}", status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

describe("TemplateManager", () => {
  it("lists own templates and those shared into the person's Homes", () => {
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    expect(within(card("Mornings")).getByText("Contains: Welcome, Notifications")).toBeVisible();
    expect(within(card("Weekend")).getByText("Shared into ⁨Thuis⁩")).toBeVisible();
  });

  it("lets any member share a personal template into each of their Homes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const mornings = card("Mornings");
    expect(within(mornings).getByRole("checkbox", { name: "Cabin" })).toBeEnabled();
    ok();
    await user.click(within(mornings).getByRole("checkbox", { name: "Thuis" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/dashboard-templates/${MINE}/shares/${HOME_A}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(await screen.findByText("Shared into ⁨Thuis⁩.")).toBeInTheDocument();
  });

  it("disables Home templates for Homes whose dashboard the person may not edit, with the reason", () => {
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const board = card("Family board");
    expect(within(board).getByRole("checkbox", { name: "Thuis" })).toBeEnabled();
    const cabin = within(board).getByRole("checkbox", { name: "Cabin" });
    expect(cabin).toBeDisabled();
    expect(cabin).toHaveAccessibleDescription(/Only people who may edit this Home's dashboard/);
  });

  it("lets a Home dashboard editor stop a share in that Home only", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const weekend = card("Weekend");
    expect(within(weekend).getAllByRole("button", { name: "Stop sharing" })).toHaveLength(1);
    ok();
    await user.click(within(weekend).getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/dashboard-templates/${SHARED}/shares/${HOME_A}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("renames, refusing an empty name", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const mornings = card("Mornings");
    await user.click(within(mornings).getByRole("button", { name: "Rename" }));
    const field = within(mornings).getByLabelText("Template name");
    await user.clear(field);
    await user.click(within(mornings).getByRole("button", { name: "Save name" }));
    expect(within(mornings).getByText("Enter a name of 1 to 80 characters.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(field, "Early");
    ok();
    await user.click(within(mornings).getByRole("button", { name: "Save name" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ name: "Early" });
  });

  it("refuses a rename to the name of another of the person's templates", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const mornings = card("Mornings");
    await user.click(within(mornings).getByRole("button", { name: "Rename" }));
    const field = within(mornings).getByLabelText("Template name");
    await user.clear(field);
    await user.type(field, " family BOARD ");
    await user.click(within(mornings).getByRole("button", { name: "Save name" }));
    expect(
      within(mornings).getByText(
        "You already have a template with this name. Choose another name.",
      ),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("duplicates an own template under a free copy name (UX2c, decision 31)", async () => {
    const user = userEvent.setup();
    const withCopy: ManagedTemplate[] = [
      ...templates,
      {
        ...(templates[1] as ManagedTemplate),
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0103",
        name: "Mornings (copy)",
      },
    ];
    renderWithQuery(<TemplateManager templates={withCopy} homes={homes} />);
    ok(JSON.stringify({ id: "new", dropped: 0 }), 201);
    await user.click(within(card("Mornings")).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/dashboard-templates/${MINE}/duplicate`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      name: "Mornings (copy 2)",
    });
    expect(await screen.findByText(/Copy saved as ⁨Mornings \(copy 2\)⁩/)).toBeInTheDocument();
  });

  it("saves a copy of a template shared with the person", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    ok(JSON.stringify({ id: "new", dropped: 1 }), 201);
    await user.click(within(card("Weekend")).getByRole("button", { name: "Save a copy" }));
    expect(await screen.findByText(/1 Home widget was left out/)).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      name: "Weekend (copy)",
    });
  });

  it("says so when the template limit is reached", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    ok(JSON.stringify({ error: "limit-reached" }), 409);
    await user.click(within(card("Mornings")).getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("previews a template's arrangement for desktop and phone", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    const mornings = card("Mornings");
    const toggle = within(mornings).getByRole("button", { name: "Preview layout" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = within(mornings).getByRole("list", { name: "Layout of Mornings" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Welcome, 6 by 2", "Notifications, 6 by 2"]);
    await user.click(within(mornings).getByRole("button", { name: "Phone" }));
    expect(within(mornings).getByRole("button", { name: "Phone" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Welcome, 1 by 2");
  });

  it("moves a template to the trash after confirming", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    await user.click(within(card("Mornings")).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete ⁨Mornings⁩?" });
    ok();
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect(await screen.findByRole("link", { name: "Open the trash" })).toHaveAttribute(
      "href",
      "/settings/trash",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("shows the empty states and that there is nowhere to share without Homes", () => {
    renderWithQuery(
      <TemplateManager templates={templates.filter((t) => t.id === MINE)} homes={[]} />,
    );
    expect(screen.getByText("Nothing shared yet")).toBeInTheDocument();
    expect(screen.getByText(/there's nowhere to share this/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderWithQuery(<TemplateManager templates={templates} homes={homes} />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
