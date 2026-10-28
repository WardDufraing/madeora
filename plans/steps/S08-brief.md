# S08 · Google sign-in — feature brief

**Branch:** `feat/google-sign-in`. Built locally on top of S07 (`feat/personal-preferences`, PR #14, open when this step started); rebased onto `main` once #14 is merged, before anything is pushed.
**Sources:** build plan S08 and its "Done when"; PS "Confirmed self-service Google and Apple sign-in method management" (L591–600), "Confirmed adult email/password and Apple/Google sign-in" (L639–646), L570 and L586 (never overwrite the Madeora email from a provider profile), L386 (reauthentication before linking/unlinking); ARCH §7 (Google through Supabase Auth, never auto-link on matching email, block removing the last usable method, Apple deferred, provider-agnostic); CLAUDE.md authentication A, €0 rule; S06 brief (browser-direct auth calls, CSRF, caches), S06b (Turnstile, production sign-up closed until S10).

## What Supabase Auth does by itself (checked in the source of the pinned Auth version, commit 4eee58f)

- **It links automatically on a matching email.** A Google sign-in whose verified email equals an existing account's email is attached to that account (`DetermineAccountLinking` → `LinkAccount`). The spec forbids this ("never link automatically from a matching email"). The only switch for it is an experimental server variable that hosted projects cannot set.
- For an **unconfirmed** password account with the same email, the Google sign-in takes the account over and removes the unconfirmed password (pre-account-takeover protection). Such an account was never usable, so it holds no data.
- **Manual linking** (`linkIdentity`) and **unlinking** (`unlinkIdentity`) are called by the browser with the user's own session. Supabase only checks "at least one identity remains"; it knows nothing about recent reauthentication or "usable" methods.
- The Google issuer is hard-coded to `https://accounts.google.com`, so tests need a stand-in for Google (below).

## Design

1. **Database guard on `auth.identities`** (Supabase still allows triggers on its auth tables; functions live in `private`, owned by `postgres`):
   - **Before insert** of a non-email identity: allowed when the account has no other identity (a brand-new Google account) or has never confirmed its email (Supabase's takeover protection above). Otherwise it needs a **link permission** for that account and provider, which is used up by the insert. Without one the insert fails, so automatic email-based linking can never happen.
   - **Before delete:** allowed when the account itself is being deleted, or is unconfirmed (Supabase's clean-up). The email/password identity cannot be removed (not offered in S08). Removing Google needs an **unlink permission**, used up by the delete, and the account must keep a usable fallback: a confirmed email with a password.
   - One permission row per account and action, valid 10 minutes, single use, in `private.sign_in_method_grants` (no API access).
2. **Recent reauthentication = typing the password again.** The settings page signs in once more with a memory-only client (never touching cookies). With that fresh session the browser calls `public.authorize_sign_in_method_change(action)`, which checks in the database that the token's own session still exists and that it records a password sign-in from the last 5 minutes, then writes the permission. The extra session is signed out straight away. Typing the password also proves the fallback method actually works, which is what "usable" means for the unlink check.
3. **Sign-in page and sign-up page:** a "Continue with Google" button (browser-direct `signInWithOAuth`, PKCE, `prompt=select_account`), returning to `/auth/callback`. The callback page exchanges the code in the browser (per-visitor rate limits, as in S06) and opens the requested page. Every failure (cancelled consent, expired or reused state, the account-linking guard, provider outage, sign-up closed) maps to a small set of privacy-safe messages. The guard's refusal reads the same as any other Google failure, plus the hint "If you already have a Madeora account, sign in another way and link Google under Settings"; it never says whether an account exists.
4. **Settings > Sign-in methods** (new card on `/settings`): shows the account email with "Email and password" (set / not set) and Google (connected / not connected, with the Google email only to the account holder). Actions:
   - **Link Google:** "This links Google to the account <email>" → password → Google → back on Settings with "Google is now linked". The callback checks the browser is still signed in to the same account that started the link; otherwise it does not take over the new session.
   - **Unlink Google:** explains the effect → password → confirmation → done. Without a usable password the button is replaced by an explanation; the database refuses anyway.
   - Google-only accounts see why Google cannot be removed and that "Forgot password" can add a password.
5. **Supabase settings:** Google provider on, manual linking on, "identity linked" and "identity unlinked" security emails on. Locally `supabase/config.toml` keeps Google off unless a developer adds their own client (documented), so CI never needs a Google secret.
6. **Profile data:** Google's name, picture and email never change the Madeora email or display name (S07 stores the display name in `user_preferences`; Supabase only updates its own `user_metadata`, which Madeora does not read).
7. **Tests:**
   - Database tests (`tests/db/rls/sign_in_methods.test.sql`, real stack in CI, shim here): first Google account, automatic linking refused, linking with a permission (used once, expires, bound to account and provider), unlink of the last method refused, unlink with a fallback allowed, email identity not removable, account deletion still works, reauthentication RPC (stale, wrong method, revoked session, anonymous).
   - Browser tests against the real Supabase Auth code with a **stand-in Google** (a local OpenID provider; Supabase Auth reaches `accounts.google.com` through a local test proxy with a throwaway certificate): first sign-in with Google lands on the personal dashboard; Google sign-in with the email of an existing password account is refused and links nothing; a password user links Google, then signs in with Google; unlinking the last method is refused and unlinking with a password works; cancelled consent; callback after switching account. They run in `pnpm test:e2e:fallback` here and in a new CI job that builds the same Supabase Auth version.
   - Unit tests for error mapping, the callback page and the settings card in both languages, axe on the new screens.
8. **Owner guide** `docs/google-sign-in-setup.md`: Google Cloud project and OAuth client (free), consent screen, redirect URIs for `madeora-preview` and `madeora-production`, Supabase provider and manual-linking settings, security emails, and how to check it worked. ADR 0010 and the cost register row.

## Out of scope (later steps)

Sign in with Apple (fee), Google Calendar (S33), setting or changing a password while signed in and removing the password method (S37), 2FA and how it combines with Google (S37), security activity history and in-app notices (S38; Supabase's own audit log and emails cover S08), deactivation and deletion (S38–S40).

## Defaults picked (owner may override)

- Reauthentication by password, valid 5 minutes; permission valid 10 minutes.
- The email/password method cannot be removed in S08.
- Google-only accounts cannot unlink Google until S37 adds "set a password"; "Forgot password" already lets them add one.
- Google email shown on Settings only to the account holder, never elsewhere.
- In production, sign-up stays closed (S06b), so Google cannot create new production accounts until S10; existing demo accounts can link Google.

## Acceptance tests (done when)

1. First sign-in with Google creates one account and opens the personal dashboard with zero Homes.
2. A password account links Google after typing its password, and both methods then sign in to the same account; a Google sign-in with a matching email but no link is refused and links nothing.
3. Unlinking Google when it is the last usable method is refused (database and UI); with a confirmed password it works.
4. Format, lint, typecheck, unit tests, build, database tests and E2E pass.
