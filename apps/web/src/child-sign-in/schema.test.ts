import {
  childSignInActionSchema,
  newPinSchema,
  passwordSchema,
  pinProblem,
  pinSignInSchema,
  usernameSchema,
} from "./schema";

describe("child usernames (S42)", () => {
  it.each(["mia", "mia.k", "noor_2014", "a-b", "x".repeat(24)])("accepts %s", (name) => {
    expect(usernameSchema.safeParse(name).success).toBe(true);
  });

  it("stores the lower-case, trimmed form", () => {
    expect(usernameSchema.parse("  Mia.K ")).toBe("mia.k");
  });

  it.each(["mi", ".mia", "mia.", "mia@home", "mia k", "x".repeat(25), "émile"])(
    "refuses %s",
    (name) => {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe("child PINs", () => {
  it.each(["2580", "1357", "73915", "20141107"])("accepts %s", (pin) => {
    expect(pinProblem(pin)).toBeNull();
  });

  it.each(["123", "123456789", "12a4", "١٢٣٤", " 2580"])("refuses the format of %j", (pin) => {
    expect(pinProblem(pin)).toBe("pinFormat");
  });

  it.each(["0000", "7777", "1234", "4567", "9876", "3210"])("refuses %s as too simple", (pin) => {
    expect(pinProblem(pin)).toBe("pinTooSimple");
  });

  it("reports the reason through the new-PIN schema", () => {
    const result = newPinSchema.safeParse("1111");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("pinTooSimple");
  });

  it("checks only the shape of a PIN typed at sign-in", () => {
    expect(
      pinSignInSchema.safeParse({
        childMembershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031",
        pin: "1234",
      }).success,
    ).toBe(true);
    expect(
      pinSignInSchema.safeParse({
        childMembershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031",
        pin: "12 34",
      }).success,
    ).toBe(false);
  });
});

describe("child passwords and guardian actions", () => {
  it("needs 8 to 72 characters", () => {
    expect(passwordSchema.safeParse("1234567").success).toBe(false);
    expect(passwordSchema.safeParse("12345678").success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(73)).success).toBe(false);
  });

  it("accepts exactly one known action per request and nothing extra", () => {
    expect(childSignInActionSchema.safeParse({ action: "unlock" }).success).toBe(true);
    expect(
      childSignInActionSchema.safeParse({
        action: "access",
        passwordSignIn: true,
        pinSignIn: false,
      }).success,
    ).toBe(true);
    expect(childSignInActionSchema.safeParse({ action: "unlock", extra: 1 }).success).toBe(false);
    expect(childSignInActionSchema.safeParse({ action: "grant-admin" }).success).toBe(false);
    expect(childSignInActionSchema.safeParse({ action: "pin", pin: "1234" }).success).toBe(false);
  });
});
