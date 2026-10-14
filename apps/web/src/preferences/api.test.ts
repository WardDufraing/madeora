import { PREFERENCES_ENDPOINT, PreferencesSaveError, savePreferences } from "./api";
import { noPreferences } from "./schema";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreferencesSaveError) return error.failure;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("savePreferences", () => {
  it("sends the change as JSON with the session cookie and returns the saved preferences", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ preferences: { ...noPreferences, locale: "nl" } }, { status: 200 }),
    );
    await expect(savePreferences({ locale: "nl" })).resolves.toEqual({
      ...noPreferences,
      locale: "nl",
    });
    expect(fetchMock).toHaveBeenCalledWith(PREFERENCES_ENDPOINT, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"locale":"nl"}',
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it.each([
    [401, "signedOut"],
    [400, "invalid"],
    [403, "failed"],
    [500, "failed"],
  ])("reports HTTP %i as %s", async (status, failure) => {
    fetchMock.mockResolvedValue(Response.json({ error: "x" }, { status }));
    expect(await failureOf(savePreferences({ locale: "en" }))).toBe(failure);
  });

  it("reports a connection problem", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await failureOf(savePreferences({ locale: "en" }))).toBe("network");
  });

  it("reports an unreadable success response as a failure", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await failureOf(savePreferences({ locale: "en" }))).toBe("failed");
  });
});
