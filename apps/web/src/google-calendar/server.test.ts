// S33: one connect attempt's state, sealed in a cookie bound to the person who started it.
import {
  STATE_MAX_AGE_SECONDS,
  newConnectAttempt,
  openConnectAttempt,
  sealConnectAttempt,
} from "./server";

vi.mock("server-only", () => ({}));

const USER = "0c0a0000-0000-4000-8000-000000000001";
const OTHER = "0c0a0000-0000-4000-8000-000000000002";
const KEY = Buffer.alloc(32, 1);
const now = new Date("2026-11-05T10:00:00Z");

function opened(cookie: string | undefined, returnedState: string | null, extra = {}) {
  return openConnectAttempt({ cookie, returnedState, userId: USER, key: KEY, now, ...extra });
}

describe("connect attempts", () => {
  it("open for the same person, state and key within ten minutes", () => {
    const attempt = newConnectAttempt(USER, now);
    const cookie = sealConnectAttempt(attempt, KEY);
    expect(opened(cookie, attempt.state)?.verifier).toBe(attempt.verifier);
    const later = new Date(now.getTime() + STATE_MAX_AGE_SECONDS * 1000);
    expect(opened(cookie, attempt.state, { now: later })).not.toBeNull();
    const tooLate = new Date(later.getTime() + 1000);
    expect(opened(cookie, attempt.state, { now: tooLate })).toBeNull();
  });

  it("refuse another person, another state, another key, a changed or missing cookie", () => {
    const attempt = newConnectAttempt(USER, now);
    const cookie = sealConnectAttempt(attempt, KEY);
    expect(opened(cookie, attempt.state, { userId: OTHER })).toBeNull();
    // A different last character (a fixed "A" was the same one whenever the random state ended in A).
    const swapped = attempt.state.endsWith("A") ? "B" : "A";
    expect(opened(cookie, `${attempt.state.slice(0, -1)}${swapped}`)).toBeNull();
    expect(opened(cookie, attempt.state.slice(1))).toBeNull();
    expect(opened(cookie, null)).toBeNull();
    expect(opened(cookie, attempt.state, { key: Buffer.alloc(32, 2) })).toBeNull();
    const tail = cookie.endsWith("xx") ? "yy" : "xx";
    expect(opened(`${cookie.slice(0, -2)}${tail}`, attempt.state)).toBeNull();
    expect(opened(undefined, attempt.state)).toBeNull();
    expect(opened("not-a-cookie", attempt.state)).toBeNull();
  });

  it("use a fresh state and an S256 challenge of the verifier", async () => {
    const a = newConnectAttempt(USER, now);
    const b = newConnectAttempt(USER, now);
    expect(a.state).not.toBe(b.state);
    const { createHash } = await import("node:crypto");
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    // The cookie reveals neither the state nor the verifier.
    const cookie = sealConnectAttempt(a, KEY);
    expect(cookie).not.toContain(a.state);
    expect(cookie).not.toContain(a.verifier);
  });
});
