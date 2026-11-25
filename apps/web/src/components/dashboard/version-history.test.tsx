import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

import type { LayoutPreview } from "@/dashboard/preview";
import type { WidgetType } from "@/dashboard/widgets";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { VersionHistory } from "./version-history";

const fetchMock: Mock<typeof fetch> = vi.fn();
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

function previewOf(widgets: readonly [string, WidgetType][]): LayoutPreview {
  const place = (w: number) => widgets.map(([id], index) => ({ id, x: 0, y: index * 2, w, h: 2 }));
  return {
    widgets: widgets.map(([id, type]) => ({ id, type, hidden: false })),
    placements: { lg: place(6), md: place(6), sm: place(1) },
  };
}

const versions = [
  {
    id: "v3",
    revision: 7,
    reason: "restore",
    savedByMe: false,
    createdAt: "2026-11-25T10:00:00Z",
    isCurrent: true,
    dropped: false,
    preview: previewOf([["a", "welcome"]]),
  },
  {
    id: "v2",
    revision: 6,
    reason: "save",
    savedByMe: true,
    createdAt: "2026-11-24T10:00:00Z",
    isCurrent: false,
    dropped: true,
    preview: previewOf([
      ["a", "welcome"],
      ["b", "notifications"],
    ]),
  },
  {
    id: "v1",
    revision: 5,
    reason: "save",
    savedByMe: true,
    createdAt: "2026-11-23T10:00:00Z",
    isCurrent: false,
    dropped: false,
    preview: previewOf([["a", "welcome"]]),
  },
];

function answer(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderHistory(props: Partial<Parameters<typeof VersionHistory>[0]> = {}): {
  onRestore: Mock;
  onClose: Mock;
  container: HTMLElement;
} {
  const onRestore = vi.fn();
  const onClose = vi.fn();
  const { container } = renderWithQuery(
    <VersionHistory
      open
      target={{ kind: "home", homeId: HOME_ID }}
      discardsChanges={false}
      pending={false}
      onClose={onClose}
      onRestore={onRestore}
      {...props}
    />,
  );
  return { onRestore, onClose, container };
}

describe("VersionHistory", () => {
  it("lists versions newest first with why, by whom (never who else) and what changed", async () => {
    answer({ versions });
    renderHistory();
    const items = await screen.findAllByTestId("dashboard-history-version");
    expect(items).toHaveLength(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/dashboard/history?homeId=${HOME_ID}`);
    expect(items[0]).toHaveTextContent("Current layout");
    expect(items[0]).toHaveTextContent("Restored an earlier version · by another editor");
    expect(items[0]).toHaveTextContent("Removed: Notifications");
    expect(within(items[0] as HTMLElement).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(items[1]).toHaveTextContent("Saved · by you");
    expect(items[1]).toHaveTextContent("Added: Notifications");
    expect(items[1]).toHaveTextContent(/no longer available/);
    expect(items[2]).toHaveTextContent("Oldest version kept: 1 widget.");
  });

  it("does not name the author on a personal dashboard", async () => {
    answer({ versions });
    renderHistory({ target: { kind: "personal" } });
    const items = await screen.findAllByTestId("dashboard-history-version");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/history");
    expect(items[1]).not.toHaveTextContent("by you");
  });

  it("previews a version, then restores it only after confirming", async () => {
    const user = userEvent.setup();
    answer({ versions });
    const { onRestore } = renderHistory({ discardsChanges: true });
    const items = await screen.findAllByTestId("dashboard-history-version");
    const preview = within(items[1] as HTMLElement).getByRole("button", { name: "Preview" });
    await user.click(preview);
    expect(preview).toHaveAttribute("aria-expanded", "true");
    expect(
      within(items[1] as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toContain("Notifications, 6 by 2");

    await user.click(within(items[1] as HTMLElement).getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog", { name: "Restore this version?" });
    expect(screen.getByTestId("dashboard-history-confirm")).toHaveFocus();
    expect(dialog).toHaveTextContent(/stays in the version history/);
    expect(dialog).toHaveTextContent(/unsaved changes in edit mode will be discarded/);
    expect(onRestore).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeInTheDocument();
    expect(
      within(screen.getAllByTestId("dashboard-history-version")[1] as HTMLElement).getByRole(
        "button",
        { name: "Restore" },
      ),
    ).toHaveFocus();
    await user.click(
      within(screen.getAllByTestId("dashboard-history-version")[2] as HTMLElement).getByRole(
        "button",
        {
          name: "Restore",
        },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    // Against the revision the history showed as current.
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }), 7);
  });

  it("explains a refused or failed history", async () => {
    answer({ error: "not-permitted" }, 403);
    renderHistory();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("says when nothing was saved yet", async () => {
    answer({ versions: [] });
    renderHistory();
    expect(await screen.findByText(/No saved versions yet/)).toBeInTheDocument();
  });

  it("loads nothing while closed", () => {
    renderHistory({ open: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    answer({ versions });
    const user = userEvent.setup();
    renderHistory();
    const items = await screen.findAllByTestId("dashboard-history-version");
    await user.click(within(items[1] as HTMLElement).getByRole("button", { name: "Preview" }));
    await waitFor(async () => {
      expect(await axeViolations(document.body)).toEqual([]);
    });
  });
});
