import {
  emailOnlySchema,
  newPasswordSchema,
  parseTokenHash,
  signInSchema,
  signUpSchema,
} from "./schemas";

function firstError(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? undefined : result.error?.issues[0]?.message;
}

describe("signUpSchema", () => {
  const valid = { email: "ada@example.test", password: "correct horse battery" };

  it("accepts an email address and a 12 to 72 byte password, trimming the address", () => {
    const result = signUpSchema.safeParse({ ...valid, email: "  ada@example.test " });
    expect(result.success && result.data.email).toBe("ada@example.test");
    expect(signUpSchema.safeParse({ ...valid, password: "a".repeat(12) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...valid, password: "a".repeat(72) }).success).toBe(true);
  });

  it.each([
    [{ email: "" }, "emailRequired"],
    [{ email: "ada" }, "emailInvalid"],
    [{ email: `${"a".repeat(250)}@x.test` }, "emailInvalid"],
    [{ password: "" }, "passwordRequired"],
    [{ password: "a".repeat(11) }, "passwordTooShort"],
    [{ password: "a".repeat(73) }, "passwordTooLong"],
    // 25 characters but 75 bytes: bcrypt's limit is in bytes.
    [{ password: "€".repeat(25) }, "passwordTooLong"],
    [
      { email: "long-address@example.test", password: "Long-Address@Example.test" },
      "passwordIsEmail",
    ],
  ])("refuses %j with %s", (override, message) => {
    expect(firstError(signUpSchema.safeParse({ ...valid, ...override }))).toBe(message);
  });

  it("counts characters, not UTF-16 units, for the minimum length", () => {
    // 6 emoji are 12 UTF-16 units but only 6 characters.
    expect(firstError(signUpSchema.safeParse({ ...valid, password: "😀".repeat(6) }))).toBe(
      "passwordTooShort",
    );
  });
});

describe("signInSchema", () => {
  it("only needs something typed as password (existing passwords may predate the rules)", () => {
    expect(signInSchema.safeParse({ email: "ada@example.test", password: "x" }).success).toBe(true);
    expect(firstError(signInSchema.safeParse({ email: "ada@example.test", password: "" }))).toBe(
      "passwordRequired",
    );
  });
});

describe("emailOnlySchema", () => {
  it("validates the address", () => {
    expect(emailOnlySchema.safeParse({ email: "ada@example.test" }).success).toBe(true);
    expect(firstError(emailOnlySchema.safeParse({ email: "nope" }))).toBe("emailInvalid");
  });
});

describe("newPasswordSchema", () => {
  it("requires both fields to match", () => {
    const password = "correct horse battery";
    expect(newPasswordSchema.safeParse({ password, confirmPassword: password }).success).toBe(true);
    const result = newPasswordSchema.safeParse({ password, confirmPassword: `${password}!` });
    expect(firstError(result)).toBe("passwordsDiffer");
    expect(result.success ? undefined : result.error.issues[0]?.path).toEqual(["confirmPassword"]);
  });
});

describe("parseTokenHash", () => {
  it("accepts Supabase token hashes", () => {
    const hash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8";
    expect(parseTokenHash(hash)).toBe(hash);
    expect(parseTokenHash(`pkce_${hash}`)).toBe(`pkce_${hash}`);
  });

  it.each([
    [undefined],
    [["a", "b"]],
    [""],
    ["short"],
    ["<script>alert(1)</script>"],
    ["g".repeat(40)],
  ])("refuses %j", (value) => {
    expect(parseTokenHash(value)).toBeNull();
  });
});
