import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { LibraryPage } from "@/photos/shapes";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { PhotosView } from "./photos-view";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const P1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const P2 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const A1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0fa1";
const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";

function library(extra: Partial<LibraryPage> = {}): LibraryPage {
  return {
    homeId: null,
    canUpload: true,
    canManage: true,
    albumId: null,
    albumName: null,
    total: 2,
    photos: [
      { id: P1, width: 400, height: 300, createdAt: "2026-11-05T10:00:00Z", canDelete: true },
      { id: P2, width: 300, height: 400, createdAt: "2026-11-05T09:00:00Z", canDelete: true },
    ],
    albums: [
      { id: A1, name: "Zomer", revision: 2, photoCount: 1, coverPhotoId: P1, canEdit: true },
    ],
    ...extra,
  };
}

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

describe("PhotosView", () => {
  it("shows the photos with authorized picture links, the albums and upload, and passes axe", async () => {
    const { container } = renderWithIntl(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled />,
    );
    const items = screen.getAllByTestId("photo-item");
    expect(items).toHaveLength(2);
    const image = items[0]?.querySelector("img");
    expect(image?.getAttribute("src")).toBe(`/api/v1/photos/${P1}/content?variant=thumb`);
    expect(screen.getByRole("link", { name: /Zomer/ }).getAttribute("href")).toBe(
      `/photos?album=${A1}`,
    );
    expect(screen.getByTestId("photo-file-input")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains when uploads are off, and hides upload for a library the person cannot add to", () => {
    const { unmount } = renderWithIntl(
      <PhotosView homeId={HOME} library={library()} offset={0} uploadsEnabled={false} />,
    );
    expect(screen.queryByTestId("photo-file-input")).toBeNull();
    expect(screen.getByText(/not available here yet/i)).toBeTruthy();
    unmount();
    renderWithIntl(
      <PhotosView
        homeId={HOME}
        library={library({ canUpload: false, photos: [], total: 0 })}
        offset={0}
        uploadsEnabled
      />,
    );
    expect(screen.queryByTestId("photo-file-input")).toBeNull();
    expect(screen.getByText(/Nothing has been added/i)).toBeTruthy();
  });

  it("moves selected photos to the trash only after a confirmation", async () => {
    fetchMock.mockResolvedValue(Response.json({ deleted: 1, skipped: 0 }));
    const user = userEvent.setup();
    renderWithIntl(<PhotosView homeId={null} library={library()} offset={0} uploadsEnabled />);
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByTestId("photos-delete"));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/seven days/i)).toBeTruthy();
    await user.click(within(dialog).getByTestId("photos-delete-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/photos/delete");
    expect(bodyOf(init)).toEqual({ photoIds: [P1] });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("takes a photo out of an album without deleting it", async () => {
    fetchMock.mockResolvedValue(Response.json({ removed: 1 }));
    const user = userEvent.setup();
    renderWithIntl(
      <PhotosView
        homeId={null}
        library={library({
          albumId: A1,
          albumName: "Zomer",
          total: 1,
          photos: library().photos.slice(0, 1),
        })}
        offset={0}
        uploadsEnabled
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByRole("button", { name: "Remove from this album" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/photo-albums/${A1}/photos`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect(bodyOf(init)).toEqual({ photoIds: [P1] });
  });

  it("adds selected photos to another album", async () => {
    fetchMock.mockResolvedValue(Response.json({ added: 1 }));
    const user = userEvent.setup();
    renderWithIntl(<PhotosView homeId={null} library={library()} offset={0} uploadsEnabled />);
    await user.click(screen.getByRole("checkbox", { name: "Select photo 2" }));
    await user.selectOptions(screen.getByLabelText("Add to album"), A1);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ photoIds: [P2] });
  });

  it("creates an album with a fresh id in the right library", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: A1 }, { status: 201 }));
    const user = userEvent.setup();
    renderWithIntl(<PhotosView homeId={HOME} library={library()} offset={0} uploadsEnabled />);
    await user.type(screen.getByRole("textbox", { name: /New album name/ }), "Herfst");
    await user.click(screen.getByTestId("album-create"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      owner: { scope: "home", homeId: HOME },
      name: "Herfst",
    });
  });

  it("shows a refused change in an alert and refreshes", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
    const user = userEvent.setup();
    renderWithIntl(<PhotosView homeId={null} library={library()} offset={0} uploadsEnabled />);
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByTestId("photos-delete"));
    await user.click(within(screen.getByRole("dialog")).getByTestId("photos-delete-confirm"));
    expect((await screen.findByTestId("photos-error")).textContent).toMatch(/changed meanwhile/i);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("refuses an unsupported or oversized file before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithIntl(<PhotosView homeId={null} library={library()} offset={0} uploadsEnabled />);
    const input = screen.getByTestId("photo-file-input");
    await user.upload(input, new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    expect(await screen.findByTestId("upload-list")).toBeTruthy();
    expect(screen.getByTestId("upload-list").textContent).toMatch(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
