import { completeChoreOnDevice, getDeviceChoreBoard, undoChoreOnDevice } from "./device-chores";
import { hashChildSecret } from "./secret-hash";

const rpc = vi.fn();
const requestHeaders = new Headers({ "x-real-ip": "203.0.113.7" });

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }),
}));

const DEVICE_HASH = "a".repeat(64);
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const CHECK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const ACTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061";
const PIN = "2580";

let pinHash = "";
let logged: string[] = [];

beforeAll(async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `sb_secret_${"x".repeat(32)}`);
  pinHash = await hashChildSecret(PIN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
  rpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function answer(attempt: Record<string, unknown>, verified?: Record<string, unknown>) {
  rpc.mockImplementation((name: string) => {
    if (name === "shared_device_attempt") {
      return Promise.resolve({
        data: [{ action_id: null, check_id: null, pin_hash: null, locked_until: null, ...attempt }],
        error: null,
      });
    }
    if (name === "shared_device_verified") {
      return Promise.resolve({ data: verified ? [verified] : [], error: null });
    }
    return Promise.resolve({ data: null, error: { code: "XX000" } });
  });
}

describe("completeChoreOnDevice", () => {
  it("completes an attributed chore without a PIN in one call", async () => {
    answer({ outcome: "completed", action_id: ACTION });
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, null)).toEqual({
      kind: "completed",
      actionId: ACTION,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("shared_device_attempt", {
      p_device_hash: DEVICE_HASH,
      p_occurrence_id: OCCURRENCE,
      p_membership_id: MEMBER,
      p_pin: false,
      p_client_key: expect.any(String) as string,
    });
  });

  it("completes only after the PIN matches the hash, and never sends or logs the PIN", async () => {
    answer(
      { outcome: "check", check_id: CHECK, pin_hash: pinHash },
      { outcome: "submitted", action_id: ACTION },
    );
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, PIN)).toEqual({
      kind: "submitted",
      actionId: ACTION,
    });
    expect(rpc).toHaveBeenLastCalledWith("shared_device_verified", {
      p_device_hash: DEVICE_HASH,
      p_check_id: CHECK,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(PIN);
    expect(logged.join("\n")).not.toContain(PIN);
  });

  it("refuses a wrong PIN without completing anything", async () => {
    answer({ outcome: "check", check_id: CHECK, pin_hash: pinHash });
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, "7391")).toEqual({
      kind: "invalid-pin",
    });
    expect(rpc).not.toHaveBeenCalledWith("shared_device_verified", expect.anything());
  });

  it.each([
    ["pin_required", { kind: "pin-required" }],
    ["pin_not_set", { kind: "pin-not-set" }],
    ["rate_limited", { kind: "rate-limited" }],
    ["device_not_approved", { kind: "device-not-approved" }],
    ["not_eligible", { kind: "not-eligible" }],
    ["already_completed", { kind: "already-done" }],
    ["steps_incomplete", { kind: "steps-incomplete" }],
    ["something_new", { kind: "unavailable" }],
  ])("maps %s", async (outcome, expected) => {
    answer({ outcome });
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, null)).toEqual(expected);
  });

  it("tells a lock only a guardian can lift from one that ends", async () => {
    answer({ outcome: "locked", locked_until: "infinity" });
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, PIN)).toEqual({
      kind: "locked",
      until: null,
    });
    answer({ outcome: "locked", locked_until: "2026-11-12T15:00:00Z" });
    expect(await completeChoreOnDevice(DEVICE_HASH, OCCURRENCE, MEMBER, PIN)).toEqual({
      kind: "locked",
      until: "2026-11-12T15:00:00Z",
    });
  });
});

describe("getDeviceChoreBoard and undoChoreOnDevice", () => {
  it("returns null for an unknown device and undefined for a malformed answer", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await getDeviceChoreBoard(DEVICE_HASH)).toBeNull();
    rpc.mockResolvedValueOnce({ data: { require_pin: "yes" }, error: null });
    expect(await getDeviceChoreBoard(DEVICE_HASH)).toBeUndefined();
  });

  it("undoes only what the database says it undid", async () => {
    rpc.mockResolvedValueOnce({ data: "undone", error: null });
    expect(await undoChoreOnDevice(DEVICE_HASH, ACTION)).toBe("undone");
    rpc.mockResolvedValueOnce({ data: "whatever", error: null });
    expect(await undoChoreOnDevice(DEVICE_HASH, ACTION)).toBe("invalid");
  });
});
