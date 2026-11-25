# UX1b — Independent review (app shell and navigation)

Branch: `feat/redesign-app-shell-navigation` vs `origin/main`. Reviewer: an independent agent with fresh context. This is an AI review, not a GitHub human approval.

Inputs: `/tmp/claude-0/UX1b.diff`, `plans/steps/UX1b-brief.md`, `docs/design/dashboard-ux-ui-redesign.md` Decisions 10, 11, 26, 27, 28, 29, 41, `CLAUDE.md`, and the touched files on the branch for context.

## Verdict: CHANGES_REQUIRED

| Severity | Count |
| -------- | ----- |
| BLOCKER  | 1     |
| HIGH     | 2     |
| MEDIUM   | 3     |
| LOW      | 6     |

## Findings

### BLOCKER

**B1. On phones the Ora launcher covers the bottom bar's More button.**
`apps/web/src/components/shell/mobile-nav.tsx:158-195` (bar `fixed bottom-0 z-30`, More is the last slot) and `apps/web/src/components/ora/ora-assistant.tsx:279` (launcher `fixed bottom-[max(1rem,…)] end-4 z-40 size-14`).

- **Impact:** Ora is enabled by default (`supabase/migrations/20261206090000_ora_settings.sql:20`, `enabled default true`) and is rendered on every `(app)` page (`app/(app)/layout.tsx:50`). On the e2e phone viewport (390 px wide), the More tab spans about x 310–382 and y 0–61 px from the bottom. The launcher spans x 318–374 and y 16–72 px. The centre of More (about x 346, y 28) falls inside the launcher, and the launcher sits higher in the stacking order (z-40 against z-30). A tap on More therefore opens Ora instead, which leaves the full menu (every destination) out of reach by touch on small screens. The e2e tests that click `button "More"` at the phone size (`shell.spec.ts`: the menu, the destination, the backdrop, the widen-to-desktop, RTL and theme axe tests) should fail Playwright's actionability check with "element intercepts pointer events" for the same reason. D26 and D27 both say explicitly: "avoid conflicts with floating Ora controls".
- **Remediation:** on small screens, place the Ora launcher above the bar. Offset it by the bar height plus the safe area (for example `bottom-[calc(env(safe-area-inset-bottom)+5rem)]` below `md`), and let it follow the bar's hidden state, or move Ora into the bar or the More menu. Add an e2e or unit assertion that the launcher and the More button do not overlap at 390×844 while Ora is enabled.

### HIGH

**H1. The collapsed desktop sidebar is too narrow for its contents, so links overflow and are clipped.**
`apps/web/src/components/shell/sidebar.tsx:117-122` together with `nav-link.tsx:51` and `packages/design-tokens/tokens.css:29`.

- **Impact:** the aside keeps `w-(--md-shell-sidebar-collapsed)` (4.5rem = 72 px) and now adds `p-3`, which leaves 48 px for the card. After the card border and the inner `p-3` / `px-3`, about 22 px is left for content. The brand mark (36 px), the expand toggle (40 px) and every collapsed `NavLink` (`w-10`, 40 px) do not fit. In the scrolling `<nav>`, `overflow-y-auto` makes the x-axis `auto` as well, so the icons are clipped and a horizontal scrollbar appears. Focus rings are cut off at the sides. The header controls spill outside the rounded card. D41 requires an accessible collapsed state that keeps "recognizable destinations". The existing e2e test "focus ring is not clipped (collapsed)" checks only the top edge, so it will not catch this.
- **Remediation:** account for the floating gutter. One option is to widen the collapsed token, or to make the gutter part of it (for example 6rem collapsed / 16.5rem expanded). Another is to use `p-2` on the aside and `px-1` inside the card while collapsed. Extend the collapsed e2e test so it also checks that the first link's left and right ring edges sit inside the nav, and that `nav.scrollWidth <= nav.clientWidth`.

**H2. Small screens have no route to All modules and no shortcuts, which contradicts D10 and the brief.**
`apps/web/src/components/shell/mobile-nav.tsx:253-259` (the More menu still renders `primaryNav` and `secondaryNav`); `favorites.tsx:25-27` (doc comment); `plans/steps/UX1b-brief.md` ("pinned shortcuts live in the More menu and All modules").

- **Impact:** `MobileNav` never calls `useFavorites` and never links to `modulesHref(homeId)`. On a phone, a person cannot reach `/modules` or `/homes/{id}/modules` from any navigation, cannot pin anything, and never sees their shortcuts. D10 says "Keep context switch, favorites, and All Modules consistent across desktop and mobile". D26 says the More menu must expose "all remaining available modules" and expects pinned favourites to have a place on mobile. The brief describes behaviour that does not exist, and the `FavoritesProvider` comment says the list is shared with "the small-screen menu", which is also not true.
- **Remediation:** in the More menu, show the core items first, then a "Shortcuts" group from `useFavorites().pinned`, then an All modules link, then Settings and Help. That mirrors the sidebar and keeps every destination reachable, either directly or through All modules. Alternatively, keep the flat list and add the All modules link plus the shortcuts group. Correct the brief and the comment. Add unit and e2e tests: More contains All modules with the context href, and a pin made on `/modules` appears in More.

### MEDIUM

**M1. The quick-create entries are not filtered by permission or eligibility.**
`mobile-nav.tsx:120-124`, `nav-items.ts:createHref`.

- **Impact:** D29 says "show only actions the user can perform and make the destination workspace clear before saving". Every Home member, including restricted roles, sees "New task", "New event" and "Add a shopping item". The links only navigate, and the destination pages enforce access, so nothing leaks. The brief records this as a deliberate deferral, but it diverges from an approved decision, and "New task" and "Add a shopping item" open list pages, not a creation surface. The menu title also does not say which workspace the item will go into.
- **Remediation:** accept this explicitly as a tracked deferral to UX3b/UX4b/UX6 (owner sign-off), or show the destination context in the sheet (for example "In Thuis" or "Personal") now. Hide entries the current role cannot use once a client capability projection exists.

**M2. Pinning in one context silently rewrites the shortcuts of the other.**
`favorites.tsx:52-58`, `nav-items.ts:resolveFavorites`.

- **Impact:** while nothing is saved, toggling in a Home materialises the Home defaults (`chores, meals, shopping`) plus the change into the single cookie. From then on Personal shows Chores and Meals, and its own defaults (Habits, Goals) disappear without warning. The reverse happens when the first pin is made in Personal. The brief names "one list" as a decision, but this particular side effect is not described or tested, and it surprises users (D10 leaves per-context persistence open, so it is not forbidden).
- **Remediation:** store per-context lists (for example `p:…|h:…`, keyed only by "personal" or "home", without Home ids, so no identifiers end up in the cookie). Or document the behaviour in the brief and add a unit test for it, so the owner decides knowingly.

**M3. The scroll-hide wiring has no tests beyond the pure function.**
`use-scroll-hide.ts:41-57`, `mobile-nav.test.tsx`.

- **Impact:** `nextScrollState` is well tested, but nothing checks that the bar actually reports `data-hidden="true"` after a downward run, that it stays shown while the Create or More menu is open (`paused`), or that it comes back on blur. The one focus test passes trivially, because the bar is never hidden in jsdom. D27 lists exactly these rules.
- **Remediation:** in `mobile-nav.test.tsx`, set `window.scrollY` and dispatch `scroll` events. Assert hidden, then shown when Create is opened, then hidden again after it closes and focus leaves. Optionally add a Playwright phone test that scrolls a long page.

### LOW

**L1. The pin toggle changes both its name and `aria-pressed`.** `all-modules.tsx:313-316`. A toggle button with `aria-pressed` should keep a stable name (for example "Pin Pets"), because screen readers already say "pressed / not pressed". At the moment they say "Remove Pets from shortcuts, pressed", the name changes under focus, and the separate announcer region (`all-modules.tsx:265`) says the same thing again. Keep one name and rely on `aria-pressed` plus the announcement. Update the tests and the e2e spec.

**L2. The pin cap is enforced only when saving.** `preferences.ts:72-75`. `MAX_FAVORITES = 8` is exactly the number of pinnable modules today, so this cannot happen yet. If a module is added, a 9th pin would show in the session and then disappear after a reload without any message. Enforce the cap in `toggle` (disable "Pin" with an explanation), or add a test that ties `MAX_FAVORITES` to `moduleNav.length`.

**L3. The All modules search has duplicated wording and a live region from the first render.** `all-modules.tsx:270-283`. The placeholder repeats the label (`searchLabel` = `searchPlaceholder`). The `role="status"` count is in the DOM from the start and updates on every keystroke. That is acceptable, but consider debouncing it and announcing only while a query is entered.

**L4. A hidden bar stays in the accessibility tree.** `mobile-nav.tsx:158-170`. After scrolling down, the bar moves off-screen with `translate-y-full`, but screen-reader virtual-cursor users can still reach it without a focus event, so the bar does not reappear. D27 asks for it to be shown during assistive-technology navigation. Keyboard focus is handled. Consider also showing the bar on `pointerdown` or touch near the bottom edge, and document the limit.

**L5. Toasts overlap the bar.** `components/ui/toast.tsx:187` (`fixed bottom-4 z-50`) sits on top of the bottom bar on phones while a toast is visible. Offset toasts by the bar height below `md`.

**L6. There is no test for the Home All-modules route.** `app/(app)/homes/[homeId]/modules/page.tsx`. It reuses `loadHomeForPage` (membership check, redirect for not-found), which is correct and consistent with the other Home pages, and it renders no Home data. Still, no unit or e2e test covers a member opening it, or a non-member or forged id getting the neutral notice. Add one e2e assertion inside an existing Home journey.

## Checks performed

- **Done condition, desktop:** a raised, rounded sidebar, the three core items, a Shortcuts group, All modules, and Settings and Help kept apart are all present. Collapsing works in logic but is visually broken (H1).
- **Done condition, mobile:** the bar has five slots, hides with hysteresis, has the Create sheet, and More opens the full menu. More is blocked by the Ora launcher (B1), and All modules and shortcuts are missing (H2). "All existing destinations stay reachable": by design yes, but in practice not on phones while Ora is enabled (B1).
- **Routing, permissions and data:** no RLS, migration or API change. The new `/modules` route (static) takes precedence over `[section]`. `/homes/[homeId]/modules` calls `requireIdentity` and `loadHomeForPage`, like the other Home pages. Links only navigate, and the destinations enforce access. Personal/Home boundary: `homeIdFromPath` validates a UUID, and Personal links never carry a Home id.
- **Cookie:** `md-favorites` is written through the existing `preferenceCookie` helper, and its value is encoded. The server parser allow-lists `/^[a-z]{2,24}$/`, removes duplicates and applies the cap. `resolveFavorites` then allow-lists against `moduleNav`. No personal data or Home ids are stored, and the cookie is never used for authorisation. Acceptable.
- **Hydration:** the server reads the cookie and passes it as `initial`, and the pathname-derived context is the same on the server and the client.
- **Accessibility:**
  - Landmarks: the bottom nav sits outside `main` and has its own label. The desktop sidebar nav and the More menu nav share "Main", but they are never shown at the same time.
  - Behaviour: `aria-current` and a non-colour bar mark the current item, and `forced-colors` is handled. The Create sheet returns focus to its button (unit and e2e). Reduced motion works because the duration tokens become 0 ms (`tokens.css:199`).
  - Known gaps: L1 and L4.
- **i18n:** every new key exists in both `en.json` and `nl.json` with ICU plurals. `openMenu` was removed and has no remaining references (grep of `apps/web/src` and `tests/e2e`).
- **RTL:** only logical properties or symmetric insets are used (`inset-x-*`, `start/end`), and the existing RTL e2e test for the menu was updated.
- **Other e2e specs:** the specs that click sidebar links (chores, meals ×2, tasks) use Home pages, where Chores, Meals and Tasks are still shown by default, so they keep passing. No other spec uses "Open menu".
- **Commands run:**
  - `pnpm exec vitest run src/components/shell src/preferences`: 13 files, 195 tests passed.
  - `pnpm exec tsc --noEmit -p apps/web`: clean.
  - E2E: not run, because there is no Supabase in this environment.

## Remaining risks

- The e2e phone tests probably fail in CI because of B1. If they pass, the launcher geometry differs from what this review assumed, and that should be checked in a real browser.
- The collapsed sidebar was judged from the CSS, not rendered. Check it visually in light, dark and RTL after the fix.
- Combining one list for all contexts with defaults that differ per context (M2) is a product choice the owner should confirm, together with the fixed five-slot bar (D26 mentions pinned favourites in the bar).
- The quick-create entries ignore roles until the creation dialogs arrive (M1).
