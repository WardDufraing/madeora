# S05 · App shell, theme and languages — feature brief

**Branch:** `feat/app-shell-theme-i18n` from `main` @ 9ab3d92 (S01–S04 merged).
**Sources:** build-plan S05 and its "Done when"; PS "Application shell and navigation" (L3250–L3259), design checklist (L3284–L3292), visual principle 3 (L3218: both themes same structure), Personal context in the switcher (L96), personal interface language (L611–L617), RTL handling (L627), persisted sidebar preference (L3205); `docs/design/design-decisions.md` (sidebar ~240/~72px, purple is only the accent, "Memories" is now Photos); ARCH §12 (strategy B), §14 (state A), §16 (icons C), §17 (motion A), §18 (next-intl A), §21; CLAUDE.md i18n A, frontend B, state A, testing A, €0 rule. Carry-overs from `reviews/steps/S04-review.md`: theme and accent set on `<html>` (L3), translated strings for dialog close, toast dismiss and region labels, toast tone labels (L9), the toast provider wrapping the whole app (M4/L5 risk).

## Actors and permissions

None yet. No accounts exist until S06, so nothing here reads or writes data, and there is no Home scope. The three preferences below are per-device presentation choices, not access decisions.

## Scope

1. **Locales with next-intl 4.14.7** (MIT, free), no locale in the URL:
   - Supported `en` (source and fallback) and `nl`. Locale resolved on the server for every request: preference cookie, else the browser's `Accept-Language`, else `en`. Unknown or malformed values fall back safely.
   - `<html lang dir>` set from the resolved locale; `dir` comes from a direction table so a right-to-left locale only needs a table entry.
   - Human-written dictionaries in `apps/web/src/i18n/messages/{en,nl}.json`, typed keys (TypeScript fails on an unknown key), ICU messages. Tests: both locales have the same keys and the same ICU arguments, every message parses, and no key is unused.
   - Every visible and announced string in the shell is translated, including the S04 component labels the shell uses (dialog close, toast region, dismiss, tone labels).
2. **Theme:** light, dark or system. System sets no `data-theme`, so the operating system decides through CSS; light or dark sets `data-theme` on `<html>` on the server, so the first paint is right and nothing flashes. Switching applies at once without a reload.
3. **App shell** (route group `(app)`): skip link, sidebar, top bar, main landmark.
   - **Sidebar (≥768px):** expanded ~240px with placeholder mark, wordmark, icons and labels; collapsed ~72px with mark and centred icons only. Collapse/expand button near the header. Width transition on the motion tokens (240ms, 0ms under reduced motion); main content widens. Collapsed labels stay the accessible name and show as a tooltip on hover and keyboard focus (dismissible with Escape, hoverable). Active item: `aria-current="page"` plus a visible non-colour cue.
   - **Top bar:** context-switcher slot showing the current context, "Personal" (spec L96), until S09 adds Homes.
   - **Mobile (<768px):** no sidebar; a menu button in the top bar opens a navigation drawer on the native `<dialog>` (focus trap, Escape, focus returns to the button, closes on navigation).
   - **Navigation items:** Dashboard, Calendar, Tasks, Chores, Meals, Shopping, Habits, Pets, Photos, Integrations, then Settings and Help. Unbuilt sections render a translated "not built yet" empty state; each module step replaces its placeholder.
   - **Settings page** (`/settings`): theme (Light / Dark / System) and language (English / Nederlands) as native radio groups.
4. **Preferences storage:** three first-party cookies (`md-theme`, `md-sidebar`, `md-locale`), allow-listed on read, one year, `SameSite=Lax`, `Secure` on https, `Path=/`. Not `HttpOnly`, because the browser writes them; they hold no identity or personal data. Server rendering reads them, so there is no hydration mismatch. S07 moves language (and later theme) to the account and keeps the cookie as the device fallback.
5. **New icons** in `packages/icons` (original, same rules as S04): dashboard, calendar, tasks, chores, meals, shopping, habits, pets, photos, integrations, settings, help, menu, sidebar collapse/expand.
6. **Shell tokens** in `packages/design-tokens`: sidebar widths.
7. **RTL safety:** a source scan rejects physical-direction utilities (`ml-`, `pr-`, `left-`, `text-left`, `rounded-l`, …) in the web app; a browser test renders the shell with `dir="rtl"` and checks the sidebar sits on the right with no horizontal overflow.

## Out of scope

Accounts and account-stored preferences (S06/S07), Homes and a working switcher (S09), user accents (S11), search, notifications bell, Ora, dashboard widgets (S17), regional formats and timezone (S07), a Household Display locale (S43/S44), any right-to-left language.

## Defaults picked (no owner question needed)

- **Cookies, not localStorage, for the three preferences:** the server can render the right theme, language and sidebar width on the first paint, which avoids a flash and hydration mismatches. Device-level until accounts exist.
- **No locale prefix in URLs** (`/settings`, not `/nl/settings`): the spec makes language a personal preference, not a page address.
- **English is the source and fallback locale.**
- **Navigation labels follow the mockup** with three changes: "Home" becomes "Dashboard" (in Madeora a Home is a household), "Household" becomes "Chores", "Memories" becomes "Photos" (design-decisions.md). No Trash in the sidebar (PS L2282).
- **Theme and language switches live on a Settings page**, not in the top bar.
- **The brand mark is a neutral placeholder "M"** until the mark and its colour are chosen (open in design-decisions.md).
- **768px** is the sidebar/mobile breakpoint (spec: breakpoints are flexible).

## Acceptance tests

1. Playwright: collapse the sidebar, reload, still collapsed (and expanded again after expanding and reloading); main content gets wider when collapsed.
2. Playwright: switch theme on Settings to dark, light and system; `data-theme` and painted colours follow at once and after reload; system follows emulated `prefers-color-scheme`.
3. Playwright: switch language nl ↔ en; texts, `<html lang>` change at once and after reload; `Accept-Language: nl` gives Dutch on a first visit.
4. Every Playwright test fails on any console error or page error, which is how React reports hydration mismatches in a production build.
5. Playwright: Tab from the top reaches the skip link and every nav item, expanded and collapsed; collapsed items keep their accessible names and show their tooltip on focus; Escape hides it. Mobile: the drawer opens, traps focus, closes with Escape and returns focus.
6. axe (Chromium, both themes, both locales, expanded, collapsed and mobile drawer) has no violations.
7. RTL: shell under `dir="rtl"` mirrors with no horizontal overflow; the physical-direction scan passes.
8. Unit: locale resolution (cookie, Accept-Language with q-values, junk), cookie parsing, dictionaries (same keys, same arguments, parse, no unused keys).
9. Format, lint, typecheck, unit tests, build, boundary build and E2E all pass.
