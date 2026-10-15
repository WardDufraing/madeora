import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AVATAR_MAX_BYTES } from "@/storage/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { AvatarSetting } from "./avatar-setting";
import { StorageUsageView } from "./storage-usage";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Storage" }),
      ),
  };
});

const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const UPLOAD_URL = "https://store.example/bucket/u/abc?X-Amz-Signature=sig";

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

function png(size = 2048, type = "image/png"): File {
  return new File([new Uint8Array(size)], "me.png", { type });
}

/** The four calls of a successful upload, in order. */
function uploadSucceeds() {
  fetchMock
    .mockResolvedValueOnce(
      Response.json(
        {
          fileId: FILE_ID,
          uploadUrl: UPLOAD_URL,
          headers: { "content-type": "image/png" },
          expiresAt: "2026-10-15T12:15:00Z",
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json({ file: { id: FILE_ID } }))
    .mockResolvedValueOnce(Response.json({ avatarFileId: FILE_ID }));
}

const base = {
  currentFileId: null,
  name: "Ward",
  accentColor: null,
  locale: "en",
  uploadsEnabled: true,
} as const;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("AvatarSetting", () => {
  it("uploads a picture straight to storage, finalizes it and makes it the global avatar", async () => {
    uploadSucceeds();
    const user = userEvent.setup();
    const { container } = renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} />);
    expect(screen.getByTestId("avatar-state")).toHaveTextContent("No picture yet");
    expect(await axeViolations(container)).toEqual([]);

    await user.upload(screen.getByLabelText("Choose a picture"), png());
    expect(await screen.findByText("Picture saved.")).toBeInTheDocument();

    const calls = fetchMock.mock.calls;
    expect(calls[0]?.[0]).toBe("/api/v1/files/upload-intents");
    expect(bodyOf(calls[0]?.[1])).toMatchObject({
      purpose: "avatar",
      contentType: "image/png",
      size: 2048,
    });
    // The bytes go to the signed link with exactly the signed headers, never through Madeora.
    expect(calls[1]?.[0]).toBe(UPLOAD_URL);
    expect(calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png" },
    });
    expect(calls[2]?.[0]).toBe(`/api/v1/files/${FILE_ID}/finalize`);
    expect(calls[3]?.[0]).toBe("/api/v1/me/avatar");
    expect(bodyOf(calls[3]?.[1])).toEqual({ fileId: FILE_ID });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("sets the override in one Home through that Home's endpoint", async () => {
    uploadSucceeds();
    const user = userEvent.setup();
    renderWithIntl(
      <AvatarSetting
        {...base}
        scope={{ kind: "home", homeId: HOME_ID }}
        inheritedFileId={FILE_ID}
      />,
    );
    expect(screen.getByTestId("avatar-state")).toHaveTextContent(
      "This Home shows your global picture.",
    );
    await user.upload(screen.getByLabelText("Choose a picture"), png());
    await screen.findByText("Picture saved.");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`/api/v1/homes/${HOME_ID}/profile/avatar`);
  });

  it("goes back to the global picture in a Home", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ avatarFileId: null }));
    const user = userEvent.setup();
    renderWithIntl(
      <AvatarSetting
        {...base}
        scope={{ kind: "home", homeId: HOME_ID }}
        currentFileId={FILE_ID}
        inheritedFileId={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Use my global picture" }));
    expect(await screen.findByText("This Home now uses your global picture.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ fileId: null });
  });

  it("refuses a file of the wrong type or size before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} />);
    await user.upload(screen.getByLabelText("Choose a picture"), png(10, "image/svg+xml"));
    expect(await screen.findByTestId("avatar-error")).toHaveTextContent(
      "Choose a JPEG, PNG or WebP",
    );
    await user.upload(screen.getByLabelText("Choose a picture"), png(AVATAR_MAX_BYTES + 1));
    await waitFor(() =>
      expect(screen.getByTestId("avatar-error")).toHaveTextContent("larger than 5 MB"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains full storage and links to the person's own storage", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "storage-full" }, { status: 409 }));
    const user = userEvent.setup();
    const { container } = renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} />);
    await user.upload(screen.getByLabelText("Choose a picture"), png());
    expect(await screen.findByTestId("avatar-error")).toHaveTextContent(
      "Your personal storage is full.",
    );
    expect(screen.getByRole("link", { name: "Open your storage" })).toHaveAttribute(
      "href",
      "/settings/storage",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it.each([
    ["invalid-image", 422, "isn't a picture we can use"],
    ["mismatch", 422, "isn't a picture we can use"],
    ["rate-limited", 429, "Too many uploads"],
    ["storage-unavailable", 503, "can't be reached"],
  ])("explains a %s refusal", async (error, status, text) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error }, { status }));
    const user = userEvent.setup();
    renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} />);
    await user.upload(screen.getByLabelText("Choose a picture"), png());
    expect(await screen.findByTestId("avatar-error")).toHaveTextContent(text);
  });

  it("treats a refused upload link as expired and a garbled intent as a failure", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { fileId: FILE_ID, uploadUrl: UPLOAD_URL, headers: {}, expiresAt: "x" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const user = userEvent.setup();
    renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} />);
    await user.upload(screen.getByLabelText("Choose a picture"), png());
    expect(await screen.findByTestId("avatar-error")).toHaveTextContent("took too long");

    fetchMock.mockResolvedValueOnce(Response.json({ uploadUrl: 42 }, { status: 201 }));
    await user.upload(screen.getByLabelText("Choose a picture"), png());
    await waitFor(() =>
      expect(screen.getByTestId("avatar-error")).toHaveTextContent("Something went wrong"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("offers only removal where storage is not set up", () => {
    renderWithIntl(
      <AvatarSetting
        {...base}
        scope={{ kind: "global" }}
        currentFileId={FILE_ID}
        uploadsEnabled={false}
      />,
    );
    expect(screen.queryByLabelText("Choose a picture")).toBeNull();
    expect(screen.getByTestId("avatar-uploads-off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove picture" })).toBeInTheDocument();
  });

  it("shows the picture through the authorized content route, never a storage link", () => {
    renderWithIntl(<AvatarSetting {...base} scope={{ kind: "global" }} currentFileId={FILE_ID} />);
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`/api/v1/files/${FILE_ID}/content`);
  });
});

describe("StorageUsageView", () => {
  const GiB = 1024 ** 3;

  it("shows used, deleted, available and total with no warning below 80%", async () => {
    const { container } = render(
      await StorageUsageView({
        usage: { allowance: GiB, used: GiB / 4, deleted: GiB / 4, reserved: 0, warning: 0 },
        locale: "en",
        pool: "personal",
      }),
    );
    expect(screen.getByTestId("storage-summary")).toHaveTextContent("512 MB of 1 GB used (50%)");
    expect(screen.getByTestId("storage-deleted")).toHaveTextContent("256 MB");
    expect(screen.getByTestId("storage-available")).toHaveTextContent("512 MB");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("storage-warning")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it.each([
    [0.85, "storage-warning", "more than 80% full"],
    [0.96, "storage-critical", "almost full (95%)"],
    [1, "storage-full", "everything else keep working"],
  ])("at %f of a Home's allowance shows %s", async (share, testId, text) => {
    render(
      await StorageUsageView({
        usage: {
          allowance: 1000,
          used: Math.round(1000 * share),
          deleted: 0,
          reserved: 0,
          warning: 0,
        },
        locale: "en",
        pool: "home",
      }),
    );
    expect(screen.getByTestId(testId)).toHaveTextContent(text);
  });
});
