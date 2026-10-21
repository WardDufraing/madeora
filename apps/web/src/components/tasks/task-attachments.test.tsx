import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TaskAttachment, TaskAttachmentView } from "@/tasks/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TaskAttachments } from "./task-attachments";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const FILE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const NEW_FILE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";

function attachment(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0a01",
    fileId: FILE,
    name: "Lease.pdf",
    contentType: "application/pdf",
    size: 250_000,
    fromSeries: false,
    seriesActive: false,
    addedAt: "2026-10-20T10:00:00Z",
    addedBy: { me: true, member: null },
    canRemove: true,
    ...overrides,
  };
}

function view(overrides: Partial<TaskAttachmentView> = {}): TaskAttachmentView {
  return {
    canAdd: true,
    canChangeSeries: false,
    limit: 10,
    attachments: [
      attachment(),
      attachment({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0a02",
        fileId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03",
        name: "Meter.jpg",
        contentType: "image/jpeg",
        size: 1_500_000,
        fromSeries: true,
        seriesActive: true,
        addedBy: { me: false, member: "m1" },
        canRemove: true,
      }),
      attachment({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0a03",
        fileId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f04",
        name: "Budget.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ],
    ...overrides,
  };
}

function show(props: Partial<Parameters<typeof TaskAttachments>[0]> = {}) {
  return renderWithQuery(
    <TaskAttachments
      taskId={TASK}
      view={view()}
      recurring={false}
      followingAllowed={false}
      storageAvailable
      members={[{ id: "m1", name: "Sam", isSelf: false }]}
      {...props}
    />,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The upload goes straight to storage with XMLHttpRequest (for progress); a fake stands in.
class FakeUpload {
  static last: FakeUpload | null = null;
  static status = 200;
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {
    FakeUpload.last = this;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    queueMicrotask(() => {
      this.status = FakeUpload.status;
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  router.refresh.mockReset();
  fetchMock.mockReset();
  FakeUpload.last = null;
  FakeUpload.status = 200;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskAttachments", () => {
  it("lists files with type, size and origin, previews images and opens or downloads through Madeora", async () => {
    const { container } = show();
    const rows = screen.getAllByTestId("task-attachment");
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("attachment-count")).toHaveTextContent("3 of 10");
    const pdf = rows[0] as HTMLElement;
    expect(within(pdf).getByText("PDF")).toBeInTheDocument();
    expect(within(pdf).getByText(/^244\skB$/)).toBeInTheDocument();
    expect(within(pdf).getByRole("link", { name: "Open Lease.pdf" })).toHaveAttribute(
      "href",
      `/api/v1/files/${FILE}/content`,
    );
    expect(within(pdf).getByRole("link", { name: "Download Lease.pdf" })).toHaveAttribute(
      "href",
      `/api/v1/files/${FILE}/content?download=1`,
    );
    const image = rows[1] as HTMLElement;
    expect(within(image).getByRole("img", { name: "Preview of Meter.jpg" })).toHaveAttribute(
      "src",
      "/api/v1/files/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03/content",
    );
    expect(within(image).getByText("From the series")).toBeInTheDocument();
    expect(within(image).getByText("Added by Sam")).toBeInTheDocument();
    // Office files only download.
    const sheet = rows[2] as HTMLElement;
    expect(within(sheet).queryByRole("link", { name: /^Open/ })).toBeNull();
    expect(within(sheet).getByText("Document")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains what may be added before a file is chosen", () => {
    show();
    const input = screen.getByLabelText("Add file");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAccessibleDescription(/up to 10 MB each, at most 10 per task/);
    expect(input.getAttribute("accept")).toContain("application/pdf");
  });

  it("shows nothing to change for someone who may only see the task", () => {
    show({
      view: view({
        canAdd: false,
        attachments: [attachment({ canRemove: false })],
      }),
    });
    expect(screen.queryByLabelText("Add file")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Download Lease.pdf" })).toBeInTheDocument();
  });

  it("says when uploads are unavailable here and when the task is full", () => {
    const { unmount } = show({ storageAvailable: false });
    expect(screen.getByText("File uploads are not available here yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add file")).toBeNull();
    unmount();
    show({ view: view({ limit: 3 }) });
    expect(screen.getByText(/maximum of 3 attachments/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Add file")).toBeNull();
  });

  it("refuses a file type or size before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    show();
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This type of file can't be attached.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads a file: intent, direct upload, then the server checks and attaches it", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith("/upload-intents")
          ? jsonResponse(201, {
              fileId: NEW_FILE,
              uploadUrl: "https://store.example/put",
              headers: { "content-type": "application/pdf" },
              expiresAt: "2026-10-20T10:15:00Z",
            })
          : jsonResponse(200, {
              file: { id: NEW_FILE },
              attachment: { id: "a-new", impact: null },
            }),
      ),
    );
    show();
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["%PDF-1.7"], "C:\\docs\\Offer.pdf", { type: "application/pdf" }),
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    const [intentUrl, intentInit] = fetchMock.mock.calls[0] ?? [];
    expect(intentUrl).toBe(`/api/v1/tasks/${TASK}/attachments/upload-intents`);
    expect(JSON.parse(intentInit?.body as string)).toMatchObject({
      contentType: "application/pdf",
      size: 8,
      name: "Offer.pdf",
    });
    expect(FakeUpload.last?.url).toBe("https://store.example/put");
    expect(FakeUpload.last?.headers).toEqual({ "content-type": "application/pdf" });
    const [finalizeUrl, finalizeInit] = fetchMock.mock.calls[1] ?? [];
    expect(finalizeUrl).toBe(`/api/v1/files/${NEW_FILE}/finalize`);
    expect(JSON.parse(finalizeInit?.body as string)).toEqual({ scope: "this" });
  });

  it("explains a refused upload and offers a retry when it can help", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "storage-full" }));
    show();
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["a"], "Notes.txt", { type: "text/plain" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("⁨Notes.txt⁩ was not added. There is no storage space left.");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();

    fetchMock.mockResolvedValue(jsonResponse(500, { error: "failed" }));
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["a"], "Notes.txt", { type: "text/plain" }),
    );
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retries the same attempt: the same request id, and only finalizing once the bytes are stored", async () => {
    const user = userEvent.setup();
    let finalizeCalls = 0;
    fetchMock.mockImplementation((url) => {
      if (url.endsWith("/upload-intents"))
        return Promise.resolve(
          jsonResponse(201, {
            fileId: NEW_FILE,
            uploadUrl: "https://store.example/put",
            headers: { "content-type": "application/pdf" },
            expiresAt: "2026-10-20T10:15:00Z",
          }),
        );
      finalizeCalls += 1;
      // The first finalize is lost on the way back; the retry succeeds.
      return finalizeCalls === 1
        ? Promise.reject(new TypeError("network"))
        : Promise.resolve(
            jsonResponse(200, {
              file: { id: NEW_FILE },
              attachment: { id: "a-new", impact: null },
            }),
          );
    });
    show();
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["%PDF-1.7"], "Offer.pdf", { type: "application/pdf" }),
    );
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url.endsWith("/upload-intents"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/finalize"))).toHaveLength(2);
  });

  it("retries an upload that failed before storage with the same request id", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "failed" }));
    show();
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["a"], "Notes.txt", { type: "text/plain" }),
    );
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const ids = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(init?.body as string) as { requestId: string }).requestId,
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it("asks the scope on an occurrence when the person may change the series, with a preview", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        url.includes("/impact")
          ? jsonResponse(200, {
              impact: { scope: "series", changed: 4, kept: 1, full: 0, completed: 2 },
            })
          : jsonResponse(500, { error: "failed" }),
      ),
    );
    show({ recurring: true, followingAllowed: true, view: view({ canChangeSeries: true }) });
    await user.upload(
      screen.getByLabelText("Add file"),
      new File(["a"], "Manual.pdf", { type: "application/pdf" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add ⁨Manual.pdf⁩ to" });
    await user.click(within(dialog).getByRole("radio", { name: "All occurrences" }));
    const impact = await within(dialog).findByTestId("attachment-impact");
    expect(impact).toHaveTextContent("4 open occurrences change.");
    expect(impact).toHaveTextContent("1 occurrence you changed on its own stays as it is.");
    expect(impact).toHaveTextContent("2 completed occurrences are never changed.");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/tasks/${TASK}/attachments/impact?scope=series`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("removes into the trash after confirming, and offers series scopes only for a series file", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { entryId: "e1", impact: null }));
    show({ recurring: true, view: view({ canChangeSeries: true }) });
    await user.click(screen.getByRole("button", { name: "Remove Lease.pdf" }));
    let dialog = screen.getByRole("dialog", { name: "Remove ⁨Lease.pdf⁩?" });
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(dialog).toHaveTextContent("It moves to the trash for 7 days");
    await user.click(within(dialog).getByTestId("attachment-remove-confirm"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/task-attachments/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0a01");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({ scope: "this", dryRun: false });

    await user.click(screen.getByRole("button", { name: "Remove Meter.jpg" }));
    dialog = screen.getByRole("dialog", { name: "Remove ⁨Meter.jpg⁩?" });
    expect(within(dialog).getByRole("radio", { name: "All occurrences" })).toBeInTheDocument();
  });
});
