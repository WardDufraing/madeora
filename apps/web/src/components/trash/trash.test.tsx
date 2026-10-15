import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import type { TrashEntry } from "@/trash/api";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { TrashView } from "./trash-view";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
};

function entry(id: string, label: string, extra: Partial<TrashEntry> = {}): TrashEntry {
  return {
    id,
    module: "sample",
    itemType: "sample",
    label,
    deletedAt: "2026-10-15T10:00:00Z",
    expiresAt: "2026-10-22T10:00:00Z",
    deletedByMe: true,
    fileCount: 0,
    ...extra,
  };
}

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

function view(entries: readonly TrashEntry[], home: { id: string; name: string } | null = null) {
  return renderWithIntl(
    <TrashView
      entries={entries}
      homeId={home?.id ?? null}
      homeName={home?.name ?? null}
      formats={formats}
      filtered={false}
      loadedAt="2026-10-15T12:00:00.000Z"
    />,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("TrashView", () => {
  it("lists each item with its deletion day and recovery deadline, and has no accessibility violations", async () => {
    const { container } = view([entry(A, "Old note", { fileCount: 2 }), entry(B, "Draft")]);
    const rows = await screen.findAllByTestId("trash-entry");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Old note");
    expect(rows[0]).toHaveTextContent("Deleted 15/10/2026");
    expect(rows[0]).toHaveTextContent("Recoverable until 22/10/2026");
    expect(rows[0]).toHaveTextContent("2 attached files");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows an explained empty state, and a different one when filters hide everything", async () => {
    const { unmount } = view([]);
    expect(await screen.findByText("The trash is empty")).toBeInTheDocument();
    unmount();
    renderWithIntl(
      <TrashView
        entries={[]}
        homeId={null}
        homeName={null}
        formats={formats}
        filtered
        loadedAt="2026-10-15T12:00:00.000Z"
      />,
    );
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
  });

  it("restores the selected items only, and says exactly what happened", async () => {
    const user = userEvent.setup();
    view([entry(A, "Old note"), entry(B, "Draft")]);
    const restore = await screen.findByTestId("trash-restore");
    await waitFor(() => {
      expect(screen.getByLabelText(/Old note/)).toBeEnabled();
    });
    expect(restore).toBeDisabled();
    await user.click(screen.getByLabelText(/Old note/));
    expect(restore).toHaveTextContent("Restore 1 selected item");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          { entryId: A, outcome: "restored", conflict: null, options: [], attachmentsLost: 1 },
        ],
      }),
    );
    await user.click(restore);
    const result = await screen.findByTestId("trash-result");
    await waitFor(() => {
      expect(result).toHaveTextContent("1 item restored.");
    });
    expect(result).toHaveTextContent("1 attached file could not come back");
    expect(result).toHaveTextContent("Only partly done.");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ entryIds: [A], resolutions: {} });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("offers the right choice for a conflict and restores with it", async () => {
    const user = userEvent.setup();
    view([entry(A, "Old note")]);
    await user.click(await screen.findByLabelText(/Old note/));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          {
            entryId: A,
            outcome: "needs_resolution",
            conflict: "slot_taken",
            options: ["clear_slot"],
            attachmentsLost: 0,
          },
        ],
      }),
    );
    await user.click(screen.getByTestId("trash-restore"));
    const conflict = await screen.findByTestId("trash-conflict");
    expect(conflict).toHaveTextContent("Another item now uses the place this item had.");
    expect(screen.getByTestId("trash-result")).toHaveTextContent(
      "1 item needs your choice before it can be restored.",
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          { entryId: A, outcome: "restored", conflict: null, options: [], attachmentsLost: 0 },
        ],
      }),
    );
    await user.click(within(conflict).getByRole("button", { name: "Restore without its place" }));
    await waitFor(() => {
      expect(screen.queryByTestId("trash-conflict")).not.toBeInTheDocument();
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      entryIds: [A],
      resolutions: { [A]: "clear_slot" },
    });
  });

  it("asks before deleting permanently, naming the scope, and never deletes on cancel", async () => {
    const user = userEvent.setup();
    view([entry(A, "Old note")], { id: HOME, name: "Thuis" });
    await user.click(await screen.findByLabelText(/Old note/));
    await user.click(screen.getByTestId("trash-delete"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this item permanently?");
    expect(dialog).toHaveTextContent("the trash of the Home");
    expect(dialog).toHaveTextContent("Thuis");
    expect(dialog).toHaveTextContent("cannot be recovered through Madeora");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("trash-delete"));
    fetchMock.mockResolvedValueOnce(
      Response.json({ results: [{ entryId: A, outcome: "not_found" }] }),
    );
    await user.click(await screen.findByTestId("trash-confirm-delete"));
    const result = screen.getByTestId("trash-result");
    await waitFor(() => {
      expect(result).toHaveTextContent("1 item could not be deleted");
    });
    expect(result).not.toHaveTextContent("Deleted permanently.");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ entryIds: [A], confirm: true });
  });

  it("empties the trash only after confirmation, for the Home asked about", async () => {
    const user = userEvent.setup();
    view([entry(A, "Old note"), entry(B, "Draft")], { id: HOME, name: "Thuis" });
    await user.click(await screen.findByTestId("trash-empty"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Empty the trash?");
    expect(dialog).toHaveTextContent("2 items shown");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          { entryId: A, outcome: "purged" },
          { entryId: B, outcome: "purged" },
        ],
      }),
    );
    await user.click(within(dialog).getByTestId("trash-confirm-empty"));
    await waitFor(() => {
      expect(screen.getByTestId("trash-result")).toHaveTextContent("Deleted permanently.");
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      homeId: HOME,
      deletedBefore: "2026-10-15T12:00:00.000Z",
      confirm: true,
    });
  });

  it("reports a failed request instead of claiming success", async () => {
    const user = userEvent.setup();
    view([entry(A, "Old note")]);
    await user.click(await screen.findByLabelText(/Old note/));
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await user.click(screen.getByTestId("trash-restore"));
    await waitFor(() => {
      expect(screen.getByTestId("trash-result")).toHaveTextContent("could not be reached");
    });
    expect(screen.getByTestId("trash-result")).not.toHaveTextContent("Restored.");
  });
});
