# Independent review: UX account menu (feat/ui-account-menu)

Diff reviewed: `git diff origin/main...HEAD` (11 files). Read-only review; no source edited.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM test-coverage gaps and a few LOW items are listed below.

## Findings

### MEDIUM

1. **No unit test that the menu's Sign out still clears caches and posts the form.**
   `apps/web/src/components/shell/account-menu.test.tsx`; `apps/web/src/components/auth/sign-out-button.tsx:20-40`.
   The `menu` variant reuses the same `<form method="post" action="/auth/sign-out">` and the same `onSubmit` (`queryClient.clear()`, `clearAccountTabStorage()`), so behaviour is preserved by inspection. Nothing asserts it for either variant, and the test only checks the button is visible.
   Remediation: add a test that submits the form in the menu variant and asserts the form `action` and `method` and that a seeded QueryClient entry is gone. The e2e specs only cover the happy path.

2. **Tabbing out and outside-press close paths are untested.**
   `account-menu.test.tsx`. The `focusout` and `pointerdown` handlers (`account-menu.tsx:34-44`) have no test.
   Remediation: add `user.tab()` out of the panel and `user.click(document.body)` cases, each expecting `aria-expanded="false"`.

### LOW

3. **Escape always moves focus to the avatar.** `account-menu.tsx:31-34`. The document-level listener does this even if focus was outside the menu. It also fires if another overlay is open. Remediation: only refocus when `element.contains(document.activeElement)`.
4. **Focus after choosing Switch account.** `account-menu.tsx:87-89`. `setOpen(false)` hides the focused link, so focus drops to body until navigation completes. Harmless because the page navigates. Optionally focus the avatar first.
5. **`pending` is never reset.** `sign-out-button.tsx:18,32`. If the POST fails at the network level, the menu item stays disabled until reload. The previous `Button loading` had the same behaviour, so this is not a regression. No in-menu pending indicator is shown for the menu variant (it is disabled but looks the same).
6. **Safari/iOS button focus.** Buttons are not focused on click, so `focusout` has `relatedTarget === null` and does not close. The `pointerdown` handler covers this, so there is no bug.
7. **Initial from a name that starts with a combining mark or emoji.** `Array.from(...)[0]` splits by code point, not grapheme. Cosmetic only.

## Explicit checks

- **Requirements / spec:** the header keeps one avatar control; Switch account and Sign out are preserved with the same `data-testid="switch-account-link"`. Nothing in the product specification was touched.
- **Disclosure ARIA:** correct pattern. A button with `aria-expanded` and `aria-controls` points to a panel that uses `hidden`. There is no `role="menu"`, which is right because the items are a link and a form button and no arrow-key menu behaviour is promised. The avatar glyph is `aria-hidden` and the button has `aria-label` "Account menu".
- **Keyboard / focus:** Escape closes and returns focus to the avatar. Tab from the avatar enters the panel in DOM order. Tabbing or Shift+Tab out closes it via `focusout` with a `relatedTarget` check. The global `:focus-visible` outline applies to the avatar and the items. Escape and tabbing out are verified by reading the code; only Escape has a unit test.
- **Sign-out:** still a real form POST to `/auth/sign-out` (works before JS loads), and still clears TanStack Query and tab storage on submit. The hidden panel's button is excluded from role queries while closed, so no stale duplicate "Sign out" button appears.
- **Other specs and tests:** grep of `tests/e2e` and `apps/web/src` found these remaining Sign out references, none needing a menu.
  - `child-sign-in.spec.ts:61` clicks the `/household` page's own form (`(auth)/household/page.tsx:70-76`, outside AppShell).
  - `adult-security.spec.ts:349,359` use session-row buttons and "Sign out everywhere".
  - `join-invitation.tsx:173` renders its own `SignOutButton` in page content (the ghost variant is unchanged).
  - Updated specs: `auth.spec.ts` (3 call sites plus the one at line 567), `google-sign-in.spec.ts` (2), `account-switching.spec.ts` (1).
  - No other spec or unit test expects a visible header Sign out or Switch account. The child and wall-display views do not use AppShell. The mobile shell uses the same header, and `mobile-nav` has no sign-out coupling. `dev/shell/page.tsx` uses AppShell without `displayName`, which defaults to null and is safe.
- **`openAccountMenu` helper:** idempotent (checks `aria-expanded`), so a second call is safe.
- **Touch target:** the avatar is `size-10` (40px) and the items are `min-h-10`, matching the project's 40px convention. Items span the full panel width.
- **RTL:** the panel uses `end-0`, text uses `text-start`, spacing uses logical `mt`/`px`, and the name is wrapped in `<bdi>`. The panel is end-aligned and flips correctly.
- **Privacy:** `displayName` comes from `stored.displayName` of the signed-in profile (`(app)/layout.tsx:44`) and is shown only inside that person's own session. It is not used as an identity key. The shell never receives other people's names.
- **Contrast:** accent-fg `#7551df` on accent-subtle `#f0ebfe` is about 4.5:1 by hand calculation. That is borderline for 16px bold text, which does not qualify as large text, and it is comparable to the existing link-pill pairing that `globals.css` states is contrast-checked. Dark `#a281fe` on `#2d2b4c` is comfortably above 4.5:1. Hover (`on-accent` on `accent`) uses the existing token pair. Recommend confirming that the personal-accent contrast test covers the fg/subtle pair for all accents.
- **nl copy:** "Accountmenu" and "Ingelogd als {name}" are correct, but the product already uses "Afmelden" for sign out. Consider "Aangemeld als {name}" for consistency.
- **i18n keys:** present in both en and nl.
- **Secrets / validation / migrations / performance:** no new inputs, no data access change, no migrations. The listeners attach only while open.
- **Maintainability:** `itemClass` in `account-menu.tsx` duplicates the menu-variant class string in `sign-out-button.tsx`. Consider a shared constant.

## Remaining risks and test gaps

- Playwright e2e was not run by this reviewer; the specs were checked statically.
- No automated axe check of the open menu panel. Consider adding one in `auth.spec.ts`.
- No screenshot or visual check of narrow-width placement (panel is `max-w-[calc(100vw-2rem)]`, so it should fit).
- The "Signed in as" copy versus "Afmelden" terminology (item 3 in the nl copy note) is an owner copy decision.
