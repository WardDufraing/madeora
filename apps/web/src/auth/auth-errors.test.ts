import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";

import { classifyAuthError } from "./auth-errors";

describe("classifyAuthError", () => {
  it.each([
    ["invalid_credentials", 400, "invalidCredentials"],
    ["user_not_found", 400, "invalidCredentials"],
    ["email_not_confirmed", 400, "emailNotConfirmed"],
    ["over_email_send_rate_limit", 429, "rateLimited"],
    ["over_request_rate_limit", 429, "rateLimited"],
    ["something_new", 429, "rateLimited"],
    ["same_password", 422, "samePassword"],
    ["otp_expired", 403, "linkInvalid"],
    ["flow_state_not_found", 404, "linkInvalid"],
    ["unexpected_failure", 500, "unknown"],
  ])("maps %s (%i) to %s", (code, status, expected) => {
    expect(classifyAuthError(new AuthApiError("message", status, code))).toBe(expected);
  });

  it("recognises weak passwords and network failures", () => {
    expect(classifyAuthError(new AuthWeakPasswordError("weak", 422, ["length"]))).toBe(
      "weakPassword",
    );
    expect(classifyAuthError(new AuthRetryableFetchError("offline", 0))).toBe("network");
    expect(classifyAuthError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyAuthError(new Error("other"))).toBe("unknown");
    expect(classifyAuthError("text")).toBe("unknown");
  });
});
