import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

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
  },
  {
    id: HOME_KIND,
    name: "Family board",
    kind: "home",
    widgets: ["home-members"],
    isMine: true,
    sharedHomeIds: [],
  },
  {
    id: SHARED,
    name: "Weekend",
    kind: "personal",
    widgets: ["quick-actions"],
    isMine: false,
    sharedHomeIds: [HOME_A, HOME_B],
  },
];

function ok() {
  fetchMock.mockResolvedValueOnce(
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
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
