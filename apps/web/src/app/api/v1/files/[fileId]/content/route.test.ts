import type { Mock } from "vitest";

import { GET } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>;
  presignGet: Mock;
  storageOn: boolean;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  rpc: vi.fn(),
  presignGet: vi.fn(),
  storageOn: true,
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@/storage/server", () => ({
  getStorage: () => (state.storageOn ? { objects: { presignGet: state.presignGet } } : null),
}));

const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const OBJECT_KEY = `h/${"b".repeat(64)}`;
const SIGNED = "https://store.example/bucket/h/bbb?X-Amz-Expires=60&X-Amz-Signature=sig";

function get(fileId = FILE_ID, search = "") {
  return GET(new Request(`https://madeora.example/api/v1/files/${fileId}/content${search}`), {
    params: Promise.resolve({ fileId }),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storageOn = true;
  state.rpc.mockReset().mockResolvedValue({
    data: [{ object_key: OBJECT_KEY, content_type: "image/webp" }],
    error: null,
  });
  state.presignGet.mockReset().mockReturnValue(SIGNED);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/v1/files/{fileId}/content", () => {
  it("asks the database with the viewer's session, then redirects to a 60-second inline link", async () => {
    const response = await get();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.rpc).toHaveBeenCalledWith("authorize_file_read", { p_file_id: FILE_ID });
    expect(state.presignGet).toHaveBeenCalledWith(OBJECT_KEY, {
      expiresInSeconds: 60,
      contentType: "image/webp",
      disposition: "inline",
    });
  });

  it("serves anything that is not a processed image as a download, never inline", async () => {
    state.rpc.mockResolvedValue({
      data: [{ object_key: OBJECT_KEY, content_type: "image/svg+xml" }],
      error: null,
    });
    await get();
    expect(state.presignGet).toHaveBeenCalledWith(
      OBJECT_KEY,
      expect.objectContaining({ disposition: "attachment" }),
    );
  });

  it("names an attachment's download by its display name and shows a PDF inline", async () => {
    state.rpc.mockResolvedValue({
      data: [
        { object_key: OBJECT_KEY, content_type: "application/pdf", display_name: "Lease.pdf" },
      ],
      error: null,
    });
    await get();
    expect(state.presignGet).toHaveBeenCalledWith(OBJECT_KEY, {
      expiresInSeconds: 60,
      contentType: "application/pdf",
      disposition: "inline",
      filename: "Lease.pdf",
    });
    await get(FILE_ID, "?download=1");
    expect(state.presignGet).toHaveBeenLastCalledWith(
      OBJECT_KEY,
      expect.objectContaining({ disposition: "attachment", filename: "Lease.pdf" }),
    );
  });

  it("always downloads an Office file, under its name", async () => {
    state.rpc.mockResolvedValue({
      data: [
        {
          object_key: OBJECT_KEY,
          content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          display_name: "Plan.docx",
        },
      ],
      error: null,
    });
    await get();
    expect(state.presignGet).toHaveBeenCalledWith(
      OBJECT_KEY,
      expect.objectContaining({ disposition: "attachment", filename: "Plan.docx" }),
    );
  });

  it("answers a file in another Home, or no file at all, with the same bare 404", async () => {
    state.rpc.mockResolvedValue({ data: [], error: null });
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
    expect(state.presignGet).not.toHaveBeenCalled();
  });

  it("answers a forged key or malformed id with 404 without asking the database", async () => {
    for (const forged of [OBJECT_KEY, "../secret", "not-a-uuid"]) {
      expect((await get(forged)).status).toBe(404);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out viewer", async () => {
    state.identity = null;
    expect((await get()).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 where storage is off and 500 when the database fails", async () => {
    state.storageOn = false;
    expect((await get()).status).toBe(404);
    state.storageOn = true;
    state.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect((await get()).status).toBe(500);
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect((await get()).status).toBe(401);
  });
});
