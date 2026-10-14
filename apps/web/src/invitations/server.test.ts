import { toPreview } from "./server";

vi.mock("@/auth/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/auth/identity", () => ({ getVerifiedIdentity: vi.fn() }));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: vi.fn(),
  getRegionalFormats: vi.fn(),
}));

describe("toPreview", () => {
  it("passes on a usable invitation's Home, role, kind and expiry", () => {
    expect(
      toPreview({
        outcome: "ok",
        home_id: "h",
        home_name: "Thuis",
        role: "member",
        kind: "link",
        expires_at: "2026-10-21T10:00:00Z",
        request_id: null,
      }),
    ).toEqual({
      outcome: "ok",
      homeName: "Thuis",
      role: "member",
      kind: "link",
      expiresAt: "2026-10-21T10:00:00Z",
    });
  });

  it("keeps nothing about the Home for outcomes that must not reveal it", () => {
    for (const outcome of [
      "invalid",
      "expired",
      "revoked",
      "used_up",
      "email_mismatch",
      "declined",
      "rate_limited",
    ]) {
      expect(toPreview({ outcome, home_name: "Thuis", home_id: "h" })).toEqual({ outcome });
    }
  });

  it("links an existing member to the Home", () => {
    expect(toPreview({ outcome: "already_member", home_id: "h", home_name: "Thuis" })).toEqual({
      outcome: "already_member",
      homeId: "h",
      homeName: "Thuis",
    });
  });

  it.each([
    ["no row", undefined],
    ["an unknown outcome", { outcome: "surprise" }],
    ["an ok row without a name", { outcome: "ok", role: "member", kind: "link", expires_at: "x" }],
    [
      "an ok row with an unknown role",
      { outcome: "ok", home_name: "T", role: "owner", kind: "link", expires_at: "x" },
    ],
    ["a member row without the Home id", { outcome: "already_member", home_name: "T" }],
  ])("fails closed on %s", (_, row) => {
    expect(toPreview(row)).toEqual({ outcome: "invalid" });
  });
});
