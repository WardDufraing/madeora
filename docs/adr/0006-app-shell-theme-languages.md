# ADR 0006: App shell, theme and languages

- **Status:** Accepted within the owner-approved internationalization (A, next-intl), frontend (B), state (A), icon (C) and animation (A) strategies in `architecture.md` §12, §14, §16, §17 and §18. It records how S05 applies them; it changes no approved decision.
- **Date:** 2026-10-13
- **Step:** S05, app shell, theme and languages

## Context

The specification's "Application shell and navigation" asks for a persistent desktop sidebar (about 240px expanded, 72px collapsed) whose state is remembered between sessions, collapsing that gives the width back to the content, a separately designed small-screen navigation, an obvious personal/household context switch, light and dark modes with the same structure, and right-to-left support. Each adult chooses their own interface language, used in every Home (spec, "Confirmed individual interface language across Homes"); the architecture starts with Dutch and English. Accounts do not exist until S06 and S07.

## Decision

### Languages

- **next-intl 4.14.7** (MIT, free; `use-intl` and `icu-minify` pinned to the same release with pnpm `overrides`, so its sibling packages do not drift ahead of it).
- **No locale in the URL.** The language is a personal preference, not a page address. `src/i18n/request.ts` resolves it on the server for every request: the choice saved on this device, else the browser's `Accept-Language` (q-values honoured, `nl-BE` matches `nl`), else English. Invalid values are ignored. Because the result depends on each request's cookies and headers, every page is rendered per request; no page is cached and shared between people.
- **English is the source and fallback locale.** Dictionaries are human-written JSON in `apps/web/src/i18n/messages/`. Keys are typed through next-intl's `AppConfig`. Tests check that both dictionaries have the same keys and the same ICU arguments, that every message formats, and that no key is unused: a key counts as used when a translator bound to its namespace is called with it, and computed lookups (navigation ids) are listed explicitly in the test.
- `<html lang>` and `dir` are set on the server. `dir` comes from `localeDirection()`, which knows the right-to-left languages, so adding one later needs no layout change. None is supported yet.
- Language names are shown in their own language ("Nederlands" on an English page), marked with `lang`.
- Choosing a language applies it at once, so moving through the options with the arrow keys switches the interface at each step. That is acceptable with two languages; before more are added, decide whether the choice should apply only on confirmation (WCAG 3.2.2).
- Unknown addresses show a translated not-found page, inside the shell for single-segment addresses and on its own for deeper ones.
- Every page sets its full title ("Instellingen · Madeora") with `pageTitle()`; the root layout sets none. Next.js does not apply a not-found file's metadata when a page calls `notFound()`, so the not-found pages render their `<title>` themselves, and a root default title would compete with it.
- next-intl's message extractor brings `@swc/core` and `@parcel/watcher`. Their install scripts are blocked by `onlyBuiltDependencies`, which is deliberate: the extractor is not used. pnpm's "Ignored build scripts" warning for them is expected; do not approve them.

### Device preferences in cookies

- Theme (`md-theme`: light, dark or system), sidebar (`md-sidebar`) and language (`md-locale`) are first-party cookies: one year, `SameSite=Lax`, `Secure` on https, `Path=/`. The browser writes them, so they are not `HttpOnly`; they hold no identity or personal data and are never used for access decisions. Values are allow-listed when read and written.
- **Why cookies and not localStorage:** the server reads them, so the first paint already has the chosen theme, language and sidebar width. There is no flash of the wrong theme and no hydration mismatch, which a localStorage value read after hydration would cause.
- **"System"** sets no `data-theme`, so the CSS from ADR 0004 follows the operating system, including when it changes while the page is open. Light and dark set `data-theme` on `<html>`, where ADR 0004 requires the theme and accent to live.
- Switching the theme updates `<html>` at once without a reload, and refreshes the server-rendered data so Back and Forward show the new choice. Switching the language saves the cookie and refreshes the server-rendered data (`router.refresh()`), so every text, the page title and `<html lang>` follow without a full page load.
- These are device-level until accounts exist. S07 stores the language (and, if the owner wants, the theme) on the account; the account value then wins and the cookie remains the fallback for signed-out pages.

### Shell

- Route group `src/app/(app)/` with a server-rendered `AppShell`: skip link, sidebar, top bar, `main` landmark. The toast provider wraps every page inside the shell with translated labels and tone names (S04 review L9, M4/L5 risk). Pages outside the `(app)` group, such as the S06 sign-in pages, add it when they need toasts.
- **Sidebar (≥768px):** the server passes the saved state, so it renders at the right width. The width animates over the `slow` motion token (240ms, 0 under reduced motion). Collapsed items keep their label as the accessible name (visually hidden text) and show it as a tooltip on hover and keyboard focus; Escape hides it (WCAG 1.4.13). The tooltip is a fixed-position box left at its static position at the link's end edge, so the scrolling navigation does not clip it and it mirrors in right-to-left layouts without measuring anything in JavaScript. The current page has `aria-current="page"`, a semibold label and a bar at the start edge, so it does not rely on colour. In forced colours the bar uses the system Highlight colour.
- **Small screens (<768px):** no sidebar. A menu button opens the same navigation in a drawer on the native `<dialog>` (focus containment, inert page, Escape, focus returns to the button). Any navigation, a click on the backdrop, or widening the window past the breakpoint closes it.
- **Top bar:** a context switcher slot that shows "Personal", the only context until Homes exist (S09). The spec requires a clearly identified Personal context even with zero Homes.
- **Navigation items** follow the reference mockup, with "Home" renamed Dashboard (a Home is a household in Madeora), "Household" renamed Chores and "Memories" renamed Photos (design-decisions.md). Settings and Help are the secondary items; Trash stays out of the sidebar (spec). Sections without a module show a translated "not built yet" page from one dynamic route; each module's step replaces it with its own route.
- **Settings page** with native radio groups for theme and language. It is the place S07 extends with account preferences.
- **Brand:** a neutral placeholder letter, because the Madeora brand mark and its fixed colour are still open.
- **Right-to-left:** logical CSS only, enforced by a source scan (`src/rtl-safe.test.ts`); arrow icons that point at an edge mirror with an `rtl:` variant.
- New tokens: sidebar widths (`--md-shell-sidebar-expanded`, `--md-shell-sidebar-collapsed`). New icons: the twelve navigation icons, menu, and sidebar collapse/expand.

### Tests

- **Vitest:** locale negotiation and fallback, direction, dictionaries, cookie parsing and format, navigation matching, sidebar (toggle and saved state, names when collapsed, translation, axe), small-screen menu, theme and language settings.
- **Playwright** (every test fails on console errors, page errors and hydration warnings, via `tests/e2e/support/browser.ts`; production React reports text mismatches but not attribute mismatches, so one test compares the server's `<html>` and sidebar attributes with the hydrated page): sidebar toggle surviving reload and widening the content; the server rendering the saved sidebar and theme; keyboard order through the skip link and every navigation item, expanded and collapsed; tooltips on focus and hover, Escape, hoverable; current-page marking; reduced motion; theme switching at once and after reload, including system following the OS; language from `Accept-Language`, switching at once without a page load and after reload, two contexts with different languages; invalid cookies; unbuilt and unknown sections; the small-screen menu; right-to-left mirroring with no sideways scroll; axe in both themes and both languages, expanded, collapsed and with the small-screen menu open; only token colours painted.

## Consequences

- Every new interface string goes into both dictionaries in the same change; CI fails otherwise.
- Pages that read device preferences are rendered per request. That is required anyway once pages show personal data.
- Module steps add their route under `(app)` and remove their id from `unbuiltSections`.
- Open, not decided here: whether the theme is stored on the account in S07, the full launch locale list, the brand mark, and the final help destination.
