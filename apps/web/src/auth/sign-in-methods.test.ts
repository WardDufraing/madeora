import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import {
  canUnlink,
  classifyCallbackError,
  classifyMethodChangeError,
  describeSignInMethods,
  parseOAuthFlow,
} from "./sign-in-methods";

const identity = (provider: string, email?: string) => ({
  id: `${provider}-1`,
  identity_id: `${provider}-identity`,
  user_id: "user-1",
  provider,
  identity_data: email === undefined ? {} : { email },
});

describe("describeSignInMethods", () => {
  it("shows the account email, never the provider's, and both methods", () => {
    const view = describeSignInMethods({
      email: "ada@example.test",
      identities: [identity("email", "ada@example.test"), identity("google", "ada@gmail.test")],
    });
    expect(view).toEqual({
      email: "ada@example.test",
      password: true,
      google: { email: "ada@gmail.test" },
    });
    expect(canUnlink(view, "google")).toBe(true);
  });

  it("never offers to unlink Google when it is the only method", () => {
    const view = describeSignInMethods({
      email: "g@gmail.test",
      identities: [identity("google", "g@gmail.test")],
    });
    expect(view.password).toBe(false);
    expect(canUnlink(view, "google")).toBe(false);
  });

  it("handles a password-only account and missing identity data", () => {
    const view = describeSignInMethods({
      email: "p@example.test",
      identities: [identity("email")],
    });
    expect(view).toEqual({ email: "p@example.test", password: true, google: null });
    expect(canUnlink(view, "google")).toBe(false);
    expect(describeSignInMethods({})).toEqual({
      email: "",
      password: false,
      google: null,
    });
    expect(
      describeSignInMethods({ email: "x@example.test", identities: [identity("google")] }).google,
    ).toEqual({ email: null });
  });
});

describe("classifyMethodChangeError", () => {
  it.each([
    [new AuthApiError("x", 400, "invalid_credentials"), "wrongPassword"],
    [new AuthApiError("x", 429, "over_request_rate_limit"), "rateLimited"],
    [new AuthApiError("x", 400, "captcha_failed"), "captchaFailed"],
    [new AuthApiError("x", 422, "identity_already_exists"), "alreadyLinked"],
    [new AuthApiError("x", 422, "single_identity_not_deletable"), "notAllowed"],
    [new AuthApiError("x", 404, "manual_linking_disabled"), "unavailable"],
    // The database guard: Supabase Auth reports a refused insert or delete as a server error.
    [new AuthApiError("Database error deleting identity", 500, "unexpected_failure"), "notAllowed"],
    [new AuthRetryableFetchError("offline", 0), "network"],
    [new AuthApiError("x", 400, "something_else"), "unknown"],
  ] as const)("%s → %s", (error, expected) => {
    expect(classifyMethodChangeError(error)).toBe(expected);
  });

  it("recognises the database's answers to the permission request", () => {
    expect(
      classifyMethodChangeError({ code: "42501", hint: "reauthentication_required", message: "x" }),
    ).toBe("reauthRequired");
    expect(classifyMethodChangeError({ code: "42501", hint: null, message: "x" })).toBe(
      "notAllowed",
    );
    expect(classifyMethodChangeError({ code: "22023", hint: null, message: "x" })).toBe("unknown");
    expect(classifyMethodChangeError(new TypeError("fetch failed"))).toBe("network");
    expect(classifyMethodChangeError("strange")).toBe("unknown");
  });
});

describe("classifyCallbackError", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("is null for a callback without an error", () => {
    expect(classifyCallbackError(params("code=abc"))).toBeNull();
  });

  it.each([
    ["error=access_denied&error_description=denied", "cancelled"],
    ["error=access_denied&error_code=signup_disabled", "signUpClosed"],
    ["error=invalid_request&error_code=identity_already_exists", "alreadyLinked"],
    ["error=invalid_request&error_code=bad_oauth_state", "expired"],
    ["error=invalid_request&error_code=flow_state_expired", "expired"],
    ["error=invalid_request&error_code=provider_disabled", "unavailable"],
    // The database refusing to attach Google to an existing account reads like any failure.
    ["error=server_error&error_description=Database+error+saving+new+user", "failed"],
    ["error_description=unexpected", "failed"],
  ] as const)("%s → %s", (query, expected) => {
    expect(classifyCallbackError(params(query))).toBe(expected);
  });
});

describe("parseOAuthFlow", () => {
  it("only recognises the link flow; everything else is a sign-in", () => {
    expect(parseOAuthFlow("link")).toBe("link");
    expect(parseOAuthFlow("LINK")).toBe("sign-in");
    expect(parseOAuthFlow(null)).toBe("sign-in");
  });
});
