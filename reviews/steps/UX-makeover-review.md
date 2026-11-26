# Independent review: UI makeover Stage 1 (feat/ui-makeover-foundation)

Reviewer: independent agent, fresh context. Scope: staged diff (19 files incl. generated `tokens.css` and `pnpm-lock.yaml`, which are absent from /tmp/claude-0/UX-makeover.diff but present in the working tree). Read-only; nothing was run except a contrast calculation.

## Verdict: PASS (0 BLOCKER, 0 HIGH, 4 MEDIUM, 5 LOW)

PASS is conditional on the owner approvals listed under "Process" (not code defects). No data, permission, privacy, copy or route change was found.

## Checks
- Requirements/scope: token + shared-component only. `radius.pill` flows through `css.ts` into `tokens.css`/`tailwind.css` (verified in working tree; the "is up to date" test guards drift). PASS.
- Cross-Home isolation / permissions / secrets / input validation / migrations: untouched. PASS.
- Contrast (computed): light `lineControl` #737b91 = 4.22:1 on white, 3.71:1 on page #eef0f6; light `fgMuted` 5.51:1 on page, 5.22:1 on canvas end; dark `lineControl` 4.08:1 on surface, 3.56:1 on elevated. All meet the 3:1 / 4.5:1 gates and the existing test iterates every surface and both canvas stops. Active nav `fg` on `surface` is 15.9-17.3:1. PASS.
- Forced-colors: active NavLink replaced the `before:` bar with `forced-colors:bg-[Highlight] text-[HighlightText]`, so the current page stays distinguishable; cards keep their 1px border so shadow reduction does not remove the boundary. PASS.
- RTL: only logical utilities used; bar removed. Reduced motion, focus style (global 2px outline) unchanged. PASS apart from M2.
- Dev page: gating copies the existing `/dev/components` pattern (`connection()` + `APP_ENV === "production"` -> `notFound()`), no secrets, no data, `noindex`. PASS, see M3 for the test gap.
- New service/dependency: only `@fontsource-variable/plus-jakarta-sans` 5.3.0, self-hosted, OFL, EUR 0, exact-pinned, lockfile updated. No runtime network, no CSP present in the app that it could break. Needs owner OK (Process).

## Findings

### MEDIUM
M1. `apps/web/src/components/dashboard/dashboard-grid.tsx:120,125` (+ `dashboard/widgets.ts:44-46`, `dashboard-grid.tsx:51`): the dashboard uses fixed `ROW_HEIGHT = 88`, `GRID_GAP = 16` and `auto-rows-[88px] gap-4`, with widgets of `minH: 2` (192px) and `minH: 3`. WidgetFrame chrome grew from about 41px header + 32px body padding to about 52px header + 36px body padding, so a minimum-height widget loses roughly 15px of content area and scrolls earlier. The preview page uses `--md-space-grid-gap` (24px) while the real dashboard stays at 16px, so `/dev/shell` is not representative of the real grid and the brief's "grid gap 24px" is not true for the dashboard. Fix: before Stage 2 either raise `ROW_HEIGHT`/`GRID_GAP` together with the grid CSS and editor math (`dashboard-editor.tsx:945-947` shares them), or verify each widget at its `minH` in both themes and at 640/1024px container breakpoints, and reword the brief. Add a test that WidgetFrame renders no divider/keeps the heading (currently nothing asserts the new structure).

M2. `apps/web/src/app/globals.css:15-19`: global `letter-spacing: -0.01em` on h1-h3. Negative tracking breaks cursive joining in Arabic/Persian scripts, and Plus Jakarta Sans has no Arabic or Hebrew glyphs (falls back to system fonts). CLAUDE.md requires RTL-safe layouts and the launch locale list is still open. Fix: scope it with `:lang(ar), :lang(fa), :lang(he)` reset (`letter-spacing: normal`) or drop it in favour of a tracking token applied per component. Same note for `-webkit-font-smoothing: antialiased` (L2).

M3. `apps/web/src/app/dev/shell/page.tsx:62-65`: no `page.test.tsx`, whereas `/dev/components` has one asserting `APP_ENV=production` throws `notFound` and other environments render. The production gate is a stated done-condition and is currently unverified for the new route. Fix: copy `app/dev/components/page.test.tsx` (production 404, development/test/preview/staging render). Also note that the gate is `APP_ENV`, so preview and staging deployments serve it unauthenticated (consistent with the existing page, no data exposed); if `APP_ENV` were ever misconfigured on production it would be served, so consider also checking `VERCEL_ENV === "production"` (cheap defence in depth) or confirm the existing behaviour is accepted.

M4. Mobile/other shells not aligned: `components/shell/mobile-nav.tsx:29,191,228,257`, `context-switcher.tsx:21,123` and `brand.tsx` still use `rounded-control` and the old tint for active/hover while the sidebar `NavLink` is now an inverted pill, so below `md` the app shows a different navigation language, and the context switcher sits next to pill chips with a 12px radius. The brief lists mobile nav under Stage 2, so this is acceptable only if Stage 1 is not released to production on its own. Fix: state this explicitly in the PR, or include the mobile nav active state now.

### LOW
L1. `nav-link.tsx:47` comment still says the page is marked by "a bar at the start edge"; the bar is gone. Active is now marked by inverted fill and weight, which is not colour-only but the comment is wrong. Update it.
L2. `globals.css:12`: `-webkit-font-smoothing: antialiased` thins light-on-dark text on macOS, slightly hurting legibility of 13px helper text in dark mode. Consider applying only in light, or drop.
L3. Touch targets: NavLink and Button md are now 44px, but `notification-bell.tsx:13` (min 40px), `sidebar.tsx:81` (40px), header account link (`app-shell.tsx:59`, about 36px) and Button `sm` (36px) remain below 44px. All pass WCAG 2.2 AA (24px) but the brief's claim of 44px applies only to some controls. Align or reword the brief.
L4. Fonts: `@fontsource` CSS uses `font-display: swap` without a metrics-matched fallback, so a layout shift occurs on first load, and no preload is set. Acceptable for MVP; consider `next/font/local` or `size-adjust` fallback in Stage 2.
L5. `dev/shell/page.tsx:70`: sample copy contains a real person's first name ("Good evening, Ward") and a real-looking employer/place. Use synthetic names (CLAUDE.md: synthetic data only). Also long multi-word button labels (e.g. Dutch) on `rounded-pill` wrap into a stadium shape; consider `rounded-control` for wrapping buttons or a `min-w`/`whitespace-nowrap` policy.

## Process (owner action before merge)
- Owner approval of the two deviations: new dependency, and radii/font superseding redesign decision 16. The product specification may define the visual language (immutable); confirm no conflict.
- Add the `docs/design/design-decisions.md` line and an ADR/changelog entry (CLAUDE.md step 10); currently deferred in the brief.
- PR must carry screenshots (light and dark) and an honest note that real widgets and the active nav item were not visually verified.

## Residual risks / test gaps
- No visual regression or axe run on the new look; contrast is covered only at token level (text on surfaces), not for composed states (e.g. `text-surface` on `bg-fg`, `hover:bg-surface` chips on canvas gradient, secondary button `shadow-selected` on `accent-subtle` hover).
- Rem-based radius tokens change every `rounded-card` consumer at once (dialogs, toasts, widgets); clipping of focus rings and inner content in `overflow-hidden` cards with a 24px radius was not checked, especially for tables and calendar cells near corners.
- Wall display and child views inherit the new tokens without review; verify at 1080p/4K distance before shipping.
- Full CI suite (e2e axe, RLS) has not been seen; only local subsets reported.
