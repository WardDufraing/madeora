import {
  createInvitationSchema,
  decisionSchema,
  formatJoinCode,
  invitationFormSchema,
  joinRequestSchema,
  looksLikeJoinCode,
  toCreateInvitation,
  type InvitationFormValues,
} from "./schema";

const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0003";

const form = (overrides: Partial<InvitationFormValues> = {}): InvitationFormValues => ({
  kind: "email",
  role: "member",
  email: "sam@example.com",
  language: "en",
  expiresIn: "7d",
  usage: "single",
  maxUses: "2",
  ...overrides,
});

describe("createInvitationSchema", () => {
  it("normalises the recipient's address", () => {
    const parsed = createInvitationSchema.parse({
      kind: "email",
      role: "member",
      email: "  Sam@Example.COM ",
      language: "nl",
      requestId: REQUEST_ID,
    });
    expect(parsed).toMatchObject({ email: "sam@example.com" });
  });

  it.each([
    ["an email kind without an address", { kind: "email", role: "member", language: "en" }],
    [
      "an email kind with an expiry",
      { kind: "email", role: "member", email: "a@b.co", language: "en", expiresIn: "24h" },
    ],
    [
      "an email language outside en and nl",
      { kind: "email", role: "member", email: "a@b.co", language: "fr" },
    ],
    ["a link without a cap", { kind: "link", role: "member", expiresIn: "7d" }],
    ["a link cap of 0", { kind: "link", role: "member", expiresIn: "7d", maxUses: 0 }],
    ["a link cap of 11", { kind: "link", role: "member", expiresIn: "7d", maxUses: 11 }],
    ["a fractional cap", { kind: "link", role: "member", expiresIn: "7d", maxUses: 2.5 }],
    ["an expiry not offered", { kind: "link", role: "member", expiresIn: "90d", maxUses: 1 }],
    ["an Owner invitation", { kind: "link", role: "owner", expiresIn: "7d", maxUses: 1 }],
    ["a join code with a role", { kind: "join_code", role: "member", expiresIn: "7d" }],
    ["a join code with a cap", { kind: "join_code", expiresIn: "7d", maxUses: 3 }],
  ])("refuses %s", (_, input) => {
    expect(createInvitationSchema.safeParse({ ...input, requestId: REQUEST_ID }).success).toBe(
      false,
    );
  });

  it("requires a request id", () => {
    expect(createInvitationSchema.safeParse({ kind: "join_code", expiresIn: "24h" }).success).toBe(
      false,
    );
  });
});

describe("invitation form", () => {
  it("names the field and the reason for a missing or malformed address", () => {
    const empty = invitationFormSchema.safeParse(form({ email: "  " }));
    expect(empty.error?.issues).toMatchObject([{ path: ["email"], message: "emailRequired" }]);
    const malformed = invitationFormSchema.safeParse(form({ email: "sam@" }));
    expect(malformed.error?.issues).toMatchObject([{ path: ["email"], message: "emailInvalid" }]);
  });

  it("ignores the address for links and codes", () => {
    expect(invitationFormSchema.safeParse(form({ kind: "link", email: "" })).success).toBe(true);
  });

  it.each(["1", "11", "2.5", "", "x"])("refuses %j people for a multi-use link", (maxUses) => {
    const parsed = invitationFormSchema.safeParse(form({ kind: "link", usage: "multi", maxUses }));
    expect(parsed.error?.issues).toMatchObject([{ path: ["maxUses"], message: "maxUsesInvalid" }]);
  });

  it("turns each kind into the API's input", () => {
    expect(toCreateInvitation(form({ email: " sam@example.com " }), REQUEST_ID)).toEqual({
      kind: "email",
      role: "member",
      email: "sam@example.com",
      language: "en",
      requestId: REQUEST_ID,
    });
    expect(toCreateInvitation(form({ kind: "link", expiresIn: "30d" }), REQUEST_ID)).toEqual({
      kind: "link",
      role: "member",
      expiresIn: "30d",
      maxUses: 1,
      requestId: REQUEST_ID,
    });
    expect(
      toCreateInvitation(form({ kind: "link", usage: "multi", maxUses: "10" }), REQUEST_ID),
    ).toMatchObject({ maxUses: 10 });
    expect(
      toCreateInvitation(form({ kind: "join_code", role: "administrator" }), REQUEST_ID),
    ).toEqual({ kind: "join_code", expiresIn: "7d", requestId: REQUEST_ID });
  });
});

describe("join codes and tokens", () => {
  it("formats a code in two groups of five", () => {
    expect(formatJoinCode("ABCDE12345")).toBe("ABCDE-12345");
    expect(formatJoinCode("short")).toBe("short");
  });

  it.each(["ABCDE12345", "abcde-12345", "ABCDE 12345", " abcde - 12345 "])(
    "recognises %j as a code",
    (value) => {
      expect(looksLikeJoinCode(value)).toBe(true);
    },
  );

  it.each(["ABCD12345", "ABCDE123456", "ABCDE_12345", ""])(
    "does not take %j for a code",
    (value) => {
      expect(looksLikeJoinCode(value)).toBe(false);
    },
  );

  it("bounds the token and refuses extra fields", () => {
    expect(joinRequestSchema.parse({ token: " x " })).toEqual({ token: "x" });
    expect(joinRequestSchema.safeParse({ token: "x".repeat(101) }).success).toBe(false);
    expect(joinRequestSchema.safeParse({ token: "x", role: "owner" }).success).toBe(false);
  });

  it("accepts only approve and decline", () => {
    expect(decisionSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(decisionSchema.safeParse({ decision: "approved" }).success).toBe(false);
  });
});
