import { isAuthError } from "@supabase/supabase-js";

/**
 * Turns a Supabase Auth failure into one of a few privacy-safe outcomes. Messages never say
 * whether an email address has an account (spec: no account enumeration).
 */
export type AuthFailure =
  | "invalidCredentials"
  | "emailNotConfirmed"
  | "rateLimited"
  | "weakPassword"
  | "samePassword"
  | "linkInvalid"
  | "network"
  | "unknown";

export function classifyAuthError(error: unknown): AuthFailure {
  if (!isAuthError(error)) return error instanceof TypeError ? "network" : "unknown";
  if (error.status === 429) return "rateLimited";
  switch (error.code) {
    case "invalid_credentials":
    case "user_not_found":
      return "invalidCredentials";
    case "email_not_confirmed":
      return "emailNotConfirmed";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "rateLimited";
    case "weak_password":
      return "weakPassword";
    case "same_password":
      return "samePassword";
    case "otp_expired":
    case "otp_disabled":
    case "flow_state_expired":
    case "flow_state_not_found":
    case "bad_code_verifier":
      return "linkInvalid";
    default:
      break;
  }
  // A fetch that never reached Supabase.
  if (error.name === "AuthRetryableFetchError") return "network";
  return "unknown";
}
