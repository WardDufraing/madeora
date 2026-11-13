import { POST as board } from "./board/route";
import { POST as complete } from "./chores/complete/route";
import { POST as undo } from "./chores/undo/route";
import { POST as lock } from "./lock/route";

/**
 * The paired display's routes (S44): same-origin JSON only, the display identified from its own
 * session (never from the body), and the database's answers mapped to HTTP.
 */

interface State {
  kind: string;
  session: { kind: string };
  board: { kind: string; board?: unknown };
}
const state = vi.hoisted((): State => ({
  kind: "display",
  session: { kind: "ok" },
  board: { kind: "ok", board: { locked: true } },
}));
const completeChore = vi.fn();
const undoChore = vi.fn();
const lockDisplay = vi.fn();

vi.mock("@/auth/identity", () => ({
  getAuthState: () => Promise.resolve({ kind: state.kind }),
}));
vi.mock("@/displays/server", () => ({
  getDisplaySession: () =>
    Promise.resolve(
      state.session.kind === "ok"
        ? {
            kind: "ok",
            session: {
              displayId: "display-from-session",
              displayName: "Keuken",
              homeName: "Thuis",
              homeTimezone: "Europe/Brussels",
            },
          }
        : state.session,
    ),
}));
vi.mock("@/displays/board", () => ({ getDisplayBoard: () => Promise.resolve(state.board) }));
vi.mock("@/displays/display-actions", () => ({
  completeChoreOnDisplay: (...args: unknown[]) => Promise.resolve(completeChore(...args)),
  undoChoreOnDisplay: (...args: unknown[]) => Promise.resolve(undoChore(...args)),
  lockOnDisplay: (...args: unknown[]) => Promise.resolve(lockDisplay(...args)),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = {
  origin: "https://madeora.example",
  host: "madeora.example",
  "content-type": "application/json",
};
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ACTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";

function post(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = sameOrigin,
) {
  return handler(
    new Request(`https://madeora.example/api/v1/display/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.kind = "display";
  state.session = { kind: "ok" };
  state.board = { kind: "ok", board: { locked: true } };
  completeChore.mockReset().mockReturnValue({ kind: "completed", actionId: ACTION });
  undoChore.mockReset().mockReturnValue("undone");
  lockDisplay.mockReset().mockReturnValue({ kind: "locked-now" });
});

describe("POST /api/v1/display/board", () => {
  it("answers a display with its board, uncached", async () => {
    const response = await post(board, "board", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ board: { locked: true } });
  });

  it("refuses anyone but a display, and a revoked one", async () => {
    state.kind = "member";
    expect((await post(board, "board", {})).status).toBe(401);
    state.kind = "display";
    state.board = { kind: "refused" };
    expect(await (await post(board, "board", {})).json()).toEqual({ error: "not-paired" });
    state.board = { kind: "unavailable" };
    expect((await post(board, "board", {})).status).toBe(503);
  });

  it("refuses a cross-site request", async () => {
    const response = await post(
      board,
      "board",
      {},
      {
        ...sameOrigin,
        origin: "https://evil.example",
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/v1/display/chores/complete", () => {
  it("completes as the member, for the display named by its session", async () => {
    const response = await post(complete, "chores/complete", {
      occurrenceId: OCCURRENCE,
      membershipId: MEMBER,
      pin: "1234",
    });
    expect(response.status).toBe(200);
    expect(completeChore).toHaveBeenCalledWith("display-from-session", OCCURRENCE, MEMBER, "1234");
  });

  it("does not accept a display id from the body", async () => {
    const response = await post(complete, "chores/complete", {
      occurrenceId: OCCURRENCE,
      membershipId: MEMBER,
      pin: null,
      displayId: "someone-else",
    });
    expect(response.status).toBe(400);
    expect(completeChore).not.toHaveBeenCalled();
  });

  it("maps refusals", async () => {
    const body = { occurrenceId: OCCURRENCE, membershipId: MEMBER, pin: null };
    for (const [kind, status, error] of [
      ["display-locked", 409, "display-locked"],
      ["actions-off", 409, "actions-off"],
      ["not-eligible", 403, "not-eligible"],
      ["invalid-pin", 401, "invalid-pin"],
      ["not-paired", 401, "not-paired"],
      ["rate-limited", 429, "rate-limited"],
    ] as const) {
      completeChore.mockReturnValueOnce({ kind });
      const response = await post(complete, "chores/complete", body);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("refuses a revoked display before acting", async () => {
    state.session = { kind: "refused" };
    const response = await post(complete, "chores/complete", {
      occurrenceId: OCCURRENCE,
      membershipId: MEMBER,
      pin: null,
    });
    expect(response.status).toBe(401);
    expect(completeChore).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/display/chores/undo", () => {
  it("undoes for this display only", async () => {
    expect((await post(undo, "chores/undo", { actionId: ACTION })).status).toBe(200);
    expect(undoChore).toHaveBeenCalledWith("display-from-session", ACTION);
    undoChore.mockReturnValueOnce("expired");
    expect((await post(undo, "chores/undo", { actionId: ACTION })).status).toBe(409);
  });
});

describe("POST /api/v1/display/lock", () => {
  it("locks with a manager's PIN, and has no way to unlock", async () => {
    expect((await post(lock, "lock", { membershipId: MEMBER, pin: "1234" })).status).toBe(200);
    expect(lockDisplay).toHaveBeenCalledWith("display-from-session", MEMBER, "1234");
    const unlock = await post(lock, "lock", { membershipId: MEMBER, pin: "1234", lock: false });
    expect(unlock.status).toBe(400);
  });

  it("maps refusals", async () => {
    lockDisplay.mockReturnValueOnce({ kind: "not-permitted" });
    expect((await post(lock, "lock", { membershipId: MEMBER, pin: "1234" })).status).toBe(403);
    lockDisplay.mockReturnValueOnce({ kind: "invalid-pin" });
    expect((await post(lock, "lock", { membershipId: MEMBER, pin: "1234" })).status).toBe(401);
    expect((await post(lock, "lock", { membershipId: MEMBER, pin: "12" })).status).toBe(400);
  });
});
