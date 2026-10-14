import { isAuthError, type User, type UserIdentity } from "@supabase/supabase-js";

/**
 * Sign-in methods of one adult account (S08): email and password, and Google. Apple follows the
 * same shape once its fee is approved (architecture.md §7), so the provider is a parameter.
 *
 * The database decides what may change (supabase/migrations/20261015090000_sign_in_methods.sql):
 * linking or unlinking needs a password sign-in from the last few minutes, and the last usable
 * method can never be removed. These helpers only describe that to the person.
 */
export type SocialProvider = "google";

/** How recent a password sign-in must be, and how long the permission it gives lasts (database). */
export const REAUTH_WINDOW_MINUTES = 5;
export const GRANT_LIFETIME_MINUTES = 10;

export interface SignInMethodsView {
  /** The Madeora account email (never replaced by a provider's email). */
  readonly email: string;
  /** True when the account has its email and password method. */
  readonly password: boolean;
  /** The linked Google identity, or null. Its email is shown only to the account holder. */
  readonly google: { readonly email: string | null } | null;
}

function identityEmail(identity: UserIdentity): string | null {
  const value: unknown = identity.identity_data?.email;
  return typeof value === "string" && value !== "" ? value : null;
}

/** What the settings page shows, from the user that Supabase Auth has just confirmed. */
export function describeSignInMethods(user: Pick<User, "email" | "identities">): SignInMethodsView {
  const identities = user.identities ?? [];
  const google = identities.find((identity) => identity.provider === "google");
  return {
    email: user.email ?? "",
    password: identities.some((identity) => identity.provider === "email"),
    google: google ? { email: identityEmail(google) } : null,
  };
}

/** Google can be removed only while email and password remain to sign in with. */
export function canUnlink(view: SignInMethodsView, provider: SocialProvider): boolean {
  return view[provider] !== null && view.password;
}

export type MethodChangeFailure =
  | "wrongPassword"
  | "reauthRequired"
  | "notAllowed"
  | "alreadyLinked"
  | "unavailable"
  | "rateLimited"
  | "captchaFailed"
  | "network"
  | "unknown";

interface DatabaseError {
  readonly code?: unknown;
  readonly hint?: unknown;
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return typeof error === "object" && error !== null && "code" in error && !isAuthError(error);
}

/** Turns a failed reauthentication, permission request, link or unlink into a message key. */
export function classifyMethodChangeError(error: unknown): MethodChangeFailure {
  if (isAuthError(error)) {
    if (error.status === 429) return "rateLimited";
    switch (error.code) {
      case "invalid_credentials":
        return "wrongPassword";
      case "captcha_failed":
        return "captchaFailed";
      case "over_request_rate_limit":
        return "rateLimited";
      case "identity_already_exists":
        return "alreadyLinked";
      case "single_identity_not_deletable":
      case "email_conflict_identity_not_deletable":
        return "notAllowed";
      case "manual_linking_disabled":
      case "provider_disabled":
        return "unavailable";
      default:
        break;
    }
    if (error.name === "AuthRetryableFetchError") return "network";
    // The database guard refused the change (Supabase Auth reports it as a server error).
    if (error.status === 500) return "notAllowed";
    return "unknown";
  }
  if (isDatabaseError(error)) {
    if (error.hint === "reauthentication_required") return "reauthRequired";
    if (error.code === "42501") return "notAllowed";
    return "unknown";
  }
  return error instanceof TypeError ? "network" : "unknown";
}

export type CallbackFailure =
  "cancelled" | "expired" | "signUpClosed" | "alreadyLinked" | "unavailable" | "failed";

/**
 * Reads the error that Supabase Auth (or Google, through it) put in the callback address. Every
 * other failure, including the database refusing to attach Google to an existing account, is
 * "failed": the page never says whether an account exists.
 */
export function classifyCallbackError(params: URLSearchParams): CallbackFailure | null {
  const error = params.get("error");
  const code = params.get("error_code");
  if (error === null && code === null && params.get("error_description") === null) return null;
  if (error === "access_denied" && (code === null || code === "access_denied")) return "cancelled";
  switch (code) {
    case "signup_disabled":
      return "signUpClosed";
    case "identity_already_exists":
      return "alreadyLinked";
    case "bad_oauth_state":
    case "bad_oauth_callback":
    case "flow_state_expired":
    case "flow_state_not_found":
      return "expired";
    case "provider_disabled":
    case "manual_linking_disabled":
      return "unavailable";
    default:
      return "failed";
  }
}

/** Where a callback for each flow goes back to. */
export type OAuthFlow = "sign-in" | "link";

export function parseOAuthFlow(value: string | null): OAuthFlow {
  return value === "link" ? "link" : "sign-in";
}

/** Remembers, for this tab only, which account started a link, so the callback can check it. */
export const LINK_STARTED_BY_KEY = "madeora.link-started-by";
