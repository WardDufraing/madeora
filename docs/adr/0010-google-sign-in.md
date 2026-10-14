# ADR 0010: Google sign-in and sign-in method management

- **Status:** Proposed for S08 within the approved architecture (§7, authentication strategy A). Needs the owner's approval with the S08 pull request, including the defaults listed under "Decision".
- **Date:** 2026-10-14
- **Step:** S08, Google sign-in (brief: `plans/steps/S08-brief.md`)

## Context

The specification asks for adult sign-in with email and password, Google and Apple, and self-service linking and unlinking of sign-in methods ("Confirmed adult email/password and Apple/Google sign-in", "Confirmed self-service Google and Apple sign-in method management"). Linking needs explicit consent after recent reauthentication, never happens because two email addresses match, never overwrites the Madeora email, and the last usable sign-in method can never be removed. Sign in with Apple stays deferred until the owner approves the Apple Developer Program fee (CLAUDE.md).

Supabase Auth, read at the pinned commit, does not do this by itself:

- A Google sign-in whose verified email matches an existing account is attached to that account automatically. Hosted projects have no setting to switch this off.
- Manual linking and unlinking are browser calls with the person's own session. Supabase only checks that one identity remains; it knows nothing about recent reauthentication or whether the remaining method can actually be used.

## Decision

**Google through Supabase Auth only**, browser-direct with PKCE, as for email and password (ADR 0007): `signInWithOAuth` with `prompt=select_account`, returning to `/auth/callback`, which exchanges the code in the browser and opens the requested page. Failures map to a few messages that never say whether an account exists. The button appears only when the project's Supabase Auth reports Google as switched on (its public `/auth/v1/settings`, re-read at most every minute), because otherwise Supabase answers with a bare error page.

**The database enforces the linking rules**, with triggers on Supabase Auth's `auth.identities` table (Supabase allows triggers there; the functions live in schema `private`):

- Adding a Google identity to an account that already has a confirmed sign-in method needs a one-time **link permission** for that account and provider. Without it the insert fails; the person sees "Signing in with Google didn't work" with the hint to link Google from Settings.
- With a permission, a deferred check when the transaction commits also requires Supabase Auth's own manual-link record: the PKCE flow state that targets this account (`auth.flow_state.linking_target_id`), for this provider, completed in that callback. A plain Google sign-in that Supabase would link by matching email has no such record, so an open permission (for example after cancelling at Google) cannot be used by it. Automatic email-based linking therefore cannot happen.
- Removing a Google identity needs a one-time **unlink permission** and a remaining usable method: a confirmed email with a password. The email/password identity cannot be removed in S08.
- Supabase Auth's own flows keep working: a brand-new Google account, the takeover of an account that never confirmed its email (Supabase's protection against pre-account takeover), and account deletion.
- Permissions come only from `public.authorize_sign_in_method_change(action, provider)`. It requires a session that still exists and recorded a password sign-in within the last **5 minutes**, and stores a permission valid for **10 minutes**, used once. Requests per account are serialized with an advisory lock.

**Reauthentication is typing the password again** in Settings › Sign-in methods. A separate, memory-only Supabase client signs in with it, asks for the permission, and signs out straight away; the browser's own session and cookies are never replaced. Typing the password also proves the remaining method works.

**Linking** sends the person to Google with `linkIdentity`. The callback checks that the browser is still signed in to the account that started the link (kept in session storage) and that Google is now linked; it never takes over a different session.

**Profile data:** Google's name, picture and email never change the Madeora email or display name. Settings shows the Google account's email only to the account holder.

**Security emails:** Supabase Auth's "identity linked" and "identity unlinked" notifications, with Madeora templates in `supabase/templates/`, tell the account's address about every change.

**Tests without Google:** the CI stack cannot reach Google, and Supabase Auth only talks to `accounts.google.com`. The browser tests therefore run in the no-Docker fallback, which builds the pinned Supabase Auth, adds PostgREST, and points Supabase Auth's real Google code at a local stand-in through a proxy with a throwaway certificate authority trusted only by that process. CI runs them in the job "E2E Google sign-in (built Supabase Auth)". The database rules have their own tests on the real Supabase stack.

**Defaults (owner may change):** password reauthentication with a 5-minute window and a 10-minute permission; the email/password method cannot be removed; a Google-only account cannot unlink Google until S37 adds "set a password" (Supabase's password reset does not add an email/password sign-in method, so it is not offered as a way); production sign-up stays closed until S10, so Google can only be linked to existing production accounts there.

## Consequences

- Each hosted project needs a Google OAuth client, the provider switched on, manual linking allowed and the migration applied first (`docs/google-sign-in-setup.md`). Free; no card.
- The triggers depend on Supabase continuing to allow triggers on `auth.identities`. If Supabase ever refuses them, Google must stay off on that project until a new design is approved; the setup guide says to stop.
- A Supabase Auth change to how identities are written could break the guard. The fallback pins the same Auth commit as the Supabase CLI, so a CLI upgrade re-runs these tests against the new version.
- A refused automatic link looks like a generic Google failure to Supabase Auth ("Database error saving new user"); the app's message explains the way forward without revealing the account.
- Password reauthentication goes through Supabase's normal sign-in, so it counts toward the same rate limits and Turnstile check as signing in.
- Apple sign-in later reuses the same guard by adding `apple` to the allowed providers.
- The commit-time check reads Supabase Auth's `auth.flow_state` (columns `linking_target_id`, `user_id`, `auth_code_issued_at`). If Supabase changes them, linking fails closed (refused) and the Google tests catch it on the next Auth version. Linking must use the PKCE flow (the implicit flow deletes its flow state and is refused); future mobile clients must use PKCE too.
- **Later steps must extend the permission function:** S37 (2FA) must require a second factor (`aal2`) for accounts that have one before granting a permission, and child and Household Display accounts (S42, S43) must never get one.
