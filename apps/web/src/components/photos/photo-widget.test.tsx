import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { widgetRegistry } from "@/dashboard/widgets";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { PhotoSlideshow, PHOTO_WIDGET_RECHECK_MS } from "./photo-slideshow";
import { PhotoWidgetSettings } from "./photo-widget-settings";
import { widgetSource } from "./photo-widget";

const P1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const P2 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const P3 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";
const A1 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0fa1";
const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";

const photo = (id: string) => ({ id, width: 800, height: 600 });
const three = { available: true, photos: [photo(P1), photo(P2), photo(P3)], missing: 0 };

const fetchMock = vi.fn<typeof fetch>();
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : "url" in input
        ? input.url
        : input.href;

let reduce = false;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  reduce = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce") && reduce,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function shownId(): string | undefined {
  const src = screen.getByTestId("photo-widget").querySelector("img")?.getAttribute("src") ?? "";
  return /photos\/([^/]+)\/content/.exec(src)?.[1];
}

describe("photo widget source", () => {
  it("never substitutes: no album or no photo is no source; one photo uses the first only", () => {
    const base = widgetRegistry.photos.config.parse({});
    expect(widgetSource(base)).toBeNull();
    expect(widgetSource({ ...base, source: "photos" })).toBeNull();
    expect(widgetSource({ ...base, source: "album", albumId: A1 })).toEqual({ albumId: A1 });
    expect(widgetSource({ ...base, source: "photo", photoIds: [P2, P1] })).toEqual({
      photoIds: [P2],
    });
    expect(widgetSource({ ...base, source: "photos", photoIds: [P2, P1] })).toEqual({
      photoIds: [P2, P1],
    });
  });

  it("refuses settings beyond the limits", () => {
    const config = widgetRegistry.photos.config;
    expect(config.safeParse({ interval: 7 }).success).toBe(false);
    expect(config.safeParse({ fit: "stretch" }).success).toBe(false);
    expect(config.safeParse({ photoIds: Array.from({ length: 51 }, () => P1) }).success).toBe(
      false,
    );
  });
});

describe("PhotoSlideshow", () => {
  it("shows the display picture with the chosen fit, with previous/next and pause, and passes axe", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <PhotoSlideshow
        homeId={HOME}
        source={{ albumId: A1 }}
        initial={three}
        mode="slideshow"
        interval={10}
        fit="cover"
      />,
    );
    const image = screen.getByRole("img", { name: "Photo 1 of 3" });
    expect(image.getAttribute("src")).toBe(`/api/v1/photos/${P1}/content?variant=display`);
    expect(image.className).toMatch(/object-cover/);
    await user.click(screen.getByRole("button", { name: "Next photo" }));
    expect(shownId()).toBe(P2);
    await user.click(screen.getByRole("button", { name: "Previous photo" }));
    await user.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(shownId()).toBe(P3);
    expect(screen.getByTestId("photo-widget-play").textContent).toBe("Pause");
    await user.click(screen.getByTestId("photo-widget-play"));
    expect(screen.getByTestId("photo-widget-play").textContent).toBe("Play");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("advances on its own, and not when paused", () => {
    vi.useFakeTimers();
    renderWithQuery(
      <PhotoSlideshow
        homeId={null}
        source={{ photoIds: [P1, P2, P3] }}
        initial={three}
        mode="slideshow"
        interval={5}
        fit="contain"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(shownId()).toBe(P2);
    fireEvent.click(screen.getByTestId("photo-widget-play"));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(shownId()).toBe(P2);
  });

  it("starts paused when reduced motion is asked for, and a static widget never advances", () => {
    vi.useFakeTimers();
    reduce = true;
    const { unmount } = renderWithQuery(
      <PhotoSlideshow
        homeId={null}
        source={{ albumId: A1 }}
        initial={three}
        mode="slideshow"
        interval={5}
        fit="contain"
      />,
    );
    expect(screen.getByTestId("photo-widget-play").textContent).toBe("Play");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(shownId()).toBe(P1);
    unmount();
    reduce = false;
    renderWithQuery(
      <PhotoSlideshow
        homeId={null}
        source={{ albumId: A1 }}
        initial={three}
        mode="static"
        interval={5}
        fit="contain"
      />,
    );
    expect(screen.queryByTestId("photo-widget-play")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(shownId()).toBe(P1);
  });

  it("shows one photo without slideshow controls", () => {
    renderWithQuery(
      <PhotoSlideshow
        homeId={null}
        source={{ photoIds: [P1] }}
        initial={{ available: true, photos: [photo(P1)], missing: 0 }}
        mode="slideshow"
        interval={5}
        fit="contain"
      />,
    );
    expect(screen.getByRole("img", { name: "Photo" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("drops a picture that fails to load and asks again which photos may be shown", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ widget: { available: true, photos: [photo(P2)], missing: 2 } }),
    );
    renderWithQuery(
      <PhotoSlideshow
        homeId={HOME}
        source={{ photoIds: [P1, P2, P3] }}
        initial={three}
        mode="static"
        interval={5}
        fit="contain"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Photo 1 of 3" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/v1/photos/widget?homeId=${HOME}&photoIds=${P1}%2C${P2}%2C${P3}`,
    );
    await waitFor(() => {
      expect(shownId()).toBe(P2);
    });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not storm the server when pictures keep failing, and says loading failed", async () => {
    fetchMock.mockResolvedValue(Response.json({ widget: three }));
    renderWithQuery(
      <PhotoSlideshow
        homeId={HOME}
        source={{ albumId: A1 }}
        initial={three}
        mode="static"
        interval={5}
        fit="contain"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Photo 1 of 3" }));
    await waitFor(() => {
      expect(shownId()).toBe(P2);
    });
    fireEvent.error(screen.getByRole("img", { name: "Photo 1 of 2" }));
    await waitFor(() => {
      expect(shownId()).toBe(P3);
    });
    fireEvent.error(screen.getByRole("img", { name: "Photo" }));
    expect(await screen.findByText("Photos could not be loaded")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops showing an album that is no longer available after the periodic check", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      Response.json({ widget: { available: false, photos: [], missing: 0 } }),
    );
    renderWithQuery(
      <PhotoSlideshow
        homeId={HOME}
        source={{ albumId: A1 }}
        initial={three}
        mode="static"
        interval={5}
        fit="contain"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_WIDGET_RECHECK_MS);
    });
    expect(screen.queryByTestId("photo-widget")).toBeNull();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("stops showing everything when the viewer lost the Home", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(Response.json({ error: "not-found" }, { status: 404 }));
    renderWithQuery(
      <PhotoSlideshow
        homeId={HOME}
        source={{ albumId: A1 }}
        initial={three}
        mode="slideshow"
        interval={300}
        fit="contain"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_WIDGET_RECHECK_MS);
    });
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("PhotoWidgetSettings", () => {
  const library = {
    homeId: HOME,
    canUpload: true,
    canManage: false,
    albumId: null,
    albumName: null,
    album: null,
    total: 2,
    photos: [
      { id: P1, width: 800, height: 600, createdAt: "2026-11-05T10:00:00Z", canDelete: false },
      { id: P2, width: 600, height: 800, createdAt: "2026-11-05T09:00:00Z", canDelete: false },
    ],
    albums: [
      {
        id: A1,
        name: "Zomer",
        revision: 1,
        photoCount: 2,
        coverPhotoId: P1,
        canEdit: false,
        shareCount: 0,
      },
    ],
    sharedAlbums: [],
    targets: [],
  };

  it("picks photos in order, offers the context's albums and previews contain and cover", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ library })));
    const onChange = vi.fn();
    const user = userEvent.setup();
    const config = { ...widgetRegistry.photos.config.parse({}), source: "photos" as const };
    const { unmount } = renderWithQuery(
      <PhotoWidgetSettings config={config} homeId={HOME} onChange={onChange} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "Select photo 2" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...config, photoIds: [P2] });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/v1/photos?scope=home&offset=0&homeId=${HOME}`,
    );
    unmount();
    renderWithQuery(
      <PhotoWidgetSettings
        config={{ ...config, photoIds: [P2], fit: "cover" }}
        homeId={HOME}
        onChange={onChange}
      />,
    );
    const preview = await screen.findByTestId("photo-widget-preview");
    expect(preview.querySelectorAll("img")).toHaveLength(2);
    expect(preview.textContent).toMatch(/never changed/);
    expect(screen.getByLabelText("Next photo after")).toBeTruthy();
  });

  it("marks a chosen album that is gone instead of replacing it", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ error: "not-found" }, { status: 404 })),
    );
    const config = {
      ...widgetRegistry.photos.config.parse({}),
      source: "album" as const,
      albumId: A1,
    };
    renderWithQuery(<PhotoWidgetSettings config={config} homeId={HOME} onChange={vi.fn()} />);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    const select = screen.getByLabelText<HTMLSelectElement>("Album");
    expect(select.value).toBe(A1);
    expect(select.selectedOptions[0]?.textContent).toBe("No longer available");
  });
});
