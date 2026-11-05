import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AlbumDetail, LibraryPage } from "@/photos/shapes";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { PhotosView } from "./photos-view";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const P1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const P2 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const A1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0fa1";
const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const HOME_B = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0002";
const HOMES = [
  { id: HOME, name: "Thuis" },
  { id: HOME_B, name: "Oma" },
];

function albumDetail(extra: Partial<AlbumDetail> = {}): AlbumDetail {
  return {
    id: A1,
    name: "Zomer",
    revision: 2,
    owned: true,
    ownerHomeName: null,
    access: "edit",
    canContribute: true,
    canShare: true,
    canRemoveShare: false,
    shareCount: 0,
    shares: [],
    ...extra,
  };
}

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
      {
        id: A1,
        name: "Zomer",
        revision: 2,
        photoCount: 1,
        coverPhotoId: P1,
        canEdit: true,
        shareCount: 0,
      },
    ],
    album: null,
    sharedAlbums: [],
    targets: [{ id: A1, name: "Zomer", ownerHomeName: null, shared: false }],
    ...extra,
  };
}

function photoAt(index: number) {
  const photo = library().photos[index];
  if (!photo) throw new Error("no such photo");
  return photo;
}

const fetchMock = vi.fn<typeof fetch>();
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : "url" in input
        ? input.url
        : input.href;

const IMPACT = {
  deletable: 1,
  skipped: 0,
  libraries: [{ personal: true, homeName: null }],
  albums: ["Zomer"],
  otherAlbums: true,
  sharedHomes: ["Oma"],
  otherHomes: false,
};
/** Answers the impact preview, then `answer` for every other request. */
function withImpact(answer: () => Response) {
  fetchMock.mockImplementation((url) =>
    Promise.resolve(
      urlOf(url) === "/api/v1/photos/deletion-impact"
        ? Response.json({ impact: IMPACT })
        : answer(),
    ),
  );
}
const calls = (url: string) => fetchMock.mock.calls.filter(([called]) => urlOf(called) === url);
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
    const { container } = renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
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
    const { unmount } = renderWithQuery(
      <PhotosView
        homeId={HOME}
        library={library()}
        offset={0}
        uploadsEnabled={false}
        homes={HOMES}
      />,
    );
    expect(screen.queryByTestId("photo-file-input")).toBeNull();
    expect(screen.getByText(/not available here yet/i)).toBeTruthy();
    unmount();
    renderWithQuery(
      <PhotosView
        homeId={HOME}
        library={library({ canUpload: false, photos: [], total: 0 })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    expect(screen.queryByTestId("photo-file-input")).toBeNull();
    expect(screen.getByText(/Nothing has been added/i)).toBeTruthy();
  });

  it("deletes from the library only after an impact preview and a confirmation", async () => {
    withImpact(() => Response.json({ deleted: 1, skipped: 0 }));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByTestId("photos-delete"));
    expect(calls("/api/v1/photos/delete")).toHaveLength(0);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/seven days/i)).toBeTruthy();
    expect(await within(dialog).findByText(/Albums that lose it: Zomer/)).toBeTruthy();
    expect(within(dialog).getByText(/Homes that lose access: Oma/)).toBeTruthy();
    expect(within(dialog).getByText(/albums you cannot see/)).toBeTruthy();
    expect(within(dialog).getByText(/widgets stop showing/i)).toBeTruthy();
    await user.click(within(dialog).getByTestId("photos-delete-confirm"));
    await waitFor(() => {
      expect(calls("/api/v1/photos/delete")).toHaveLength(1);
    });
    expect(bodyOf(calls("/api/v1/photos/delete")[0]?.[1])).toEqual({ photoIds: [P1] });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("takes a photo out of an album without deleting it", async () => {
    fetchMock.mockResolvedValue(Response.json({ removed: 1 }));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView
        homeId={null}
        library={library({
          albumId: A1,
          albumName: "Zomer",
          album: albumDetail(),
          total: 1,
          photos: library()
            .photos.slice(0, 1)
            .map((photo) => ({ ...photo, canRemove: true })),
        })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
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
    renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
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
    renderWithQuery(
      <PhotosView homeId={HOME} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
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
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    withImpact(() => Response.json({ error: "conflict" }, { status: 409 }));
    await user.click(screen.getByTestId("photos-delete"));
    const confirm = within(screen.getByRole("dialog")).getByTestId("photos-delete-confirm");
    await waitFor(() => {
      expect(confirm.hasAttribute("disabled")).toBe(false);
    });
    await user.click(confirm);
    expect((await screen.findByTestId("photos-error")).textContent).toMatch(/changed meanwhile/i);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("refuses an unsupported or oversized file before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
    const input = screen.getByTestId("photo-file-input");
    await user.upload(input, new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    expect(await screen.findByTestId("upload-list")).toBeTruthy();
    expect(screen.getByTestId("upload-list").textContent).toMatch(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a library deletion without any change", async () => {
    withImpact(() => Response.json({ deleted: 1, skipped: 0 }));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView homeId={null} library={library()} offset={0} uploadsEnabled homes={HOMES} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByTestId("photos-delete"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(calls("/api/v1/photos/delete")).toHaveLength(0);
  });

  it("offers a contributor Remove from this album but no library deletion of others' photos", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView
        homeId={HOME_B}
        library={library({
          albumId: A1,
          albumName: "Zomer",
          album: albumDetail({
            owned: false,
            ownerHomeName: "Thuis",
            access: "contribute",
            canShare: false,
          }),
          photos: [
            { ...photoAt(0), canDelete: false, canRemove: false },
            { ...photoAt(1), canDelete: false, canRemove: true },
          ],
        })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    expect(screen.getByTestId("shared-album-note").textContent).toMatch(/belongs to Thuis/);
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    expect(screen.queryByTestId("photos-remove-from-album")).toBeNull();
    expect(screen.queryByTestId("photos-delete")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Select photo 2" }));
    expect(screen.getByTestId("photos-remove-from-album")).toBeTruthy();
    expect(screen.queryByTestId("photos-delete")).toBeNull();
    expect(screen.queryByTestId("album-sharing")).toBeNull();
  });

  it("explains a shared album's audience before adding photos to it", async () => {
    fetchMock.mockResolvedValue(Response.json({ added: 1 }));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView
        homeId={null}
        library={library({
          targets: [{ id: A1, name: "Zomer", ownerHomeName: "Thuis", shared: true }],
        })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 2" }));
    await user.selectOptions(screen.getByLabelText("Add to album"), A1);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/members of other Homes/)).toBeTruthy();
    await user.click(within(dialog).getByTestId("add-shared-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(`/api/v1/photo-albums/${A1}/photos`);
  });

  it("removes a shared album from this Home after saying no photo is deleted", async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView
        homeId={HOME_B}
        library={library({
          albumId: A1,
          album: albumDetail({
            owned: false,
            ownerHomeName: "Thuis",
            access: "view",
            canContribute: false,
            canShare: false,
            canRemoveShare: true,
          }),
        })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    await user.click(screen.getByTestId("album-remove-from-home"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/No photo is deleted/)).toBeTruthy();
    await user.click(within(dialog).getByTestId("album-remove-from-home-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/photo-albums/${A1}/shares`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect(bodyOf(init)).toEqual({ homeId: HOME_B });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_B}/photos`);
    });
  });

  it("shares an album with chosen Homes after previewing the audience, and passes axe", async () => {
    fetchMock.mockResolvedValue(Response.json({ shareCount: 1 }));
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <PhotosView
        homeId={HOME}
        library={library({ homeId: HOME, albumId: A1, album: albumDetail() })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    const sharing = screen.getByTestId("album-sharing");
    expect(within(sharing).queryByRole("checkbox", { name: "Thuis" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(sharing).getByRole("checkbox", { name: "Oma" }));
    await user.selectOptions(within(sharing).getByLabelText("Access for Oma"), "contribute");
    await user.click(screen.getByTestId("album-share-review"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Oma: Can view and add photos")).toBeTruthy();
    expect(within(dialog).getByText(/cannot be taken back/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("album-share-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/photo-albums/${A1}/shares`);
    expect(bodyOf(init)).toEqual({ shares: [{ homeId: HOME_B, access: "contribute" }] });
  });

  it("says who loses access before removing photos from a shared album", async () => {
    fetchMock.mockResolvedValue(Response.json({ removed: 1 }));
    const user = userEvent.setup();
    renderWithQuery(
      <PhotosView
        homeId={null}
        library={library({
          albumId: A1,
          album: albumDetail({ shareCount: 2 }),
          photos: [{ ...photoAt(0), canRemove: true }],
          total: 1,
        })}
        offset={0}
        uploadsEnabled
        homes={HOMES}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select photo 1" }));
    await user.click(screen.getByTestId("photos-remove-from-album"));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/loses access/)).toBeTruthy();
    await user.click(within(dialog).getByTestId("remove-shared-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
