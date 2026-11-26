# UI makeover, Stage 1: foundation (branch feat/ui-makeover-foundation)

Requested by Ward 2026-11-26: Madeora does not feel high-end, easy to use or thought through, in light and dark.
References (feel only): monochrome glassy dashboard with big rounded cards, bright widget dashboard with soft cards, family hub with slim sidebar.

## Audit: why it feels off

1. Type: system font stack, 30px title at semibold, widget titles at 15px with a divider line. No personality, weak hierarchy.
2. Geometry: 14px cards / 8px controls read as an admin panel; references use 24-28px cards and pill buttons.
3. Density: widget header was `px-4 py-2` with a rule under it, body `p-4`. Content sits tight against edges.
4. Elevation: border plus inset highlight plus shadow on every surface, so cards look outlined rather than floating.
5. Colour: page #f7f8fc vs white cards (almost no separation in light); dark surfaces 3 steps apart from the page.
6. Navigation: active item is a faint tint plus a 4px bar; no clear "you are here". Buttons 8px radius, small.

## Changes (token and shared-component level only)

- Tokens: Plus Jakarta Sans (self-hosted via @fontsource-variable, no runtime network, OFL, EUR 0); page title 32px; section title 19px; radii control 12 / card 24 / overlay 28 / new pill; widget padding and preview grid gap 24px (the real dashboard grid keeps its 16px gap and 88px rows until Stage 2 re-verifies every widget at its minimum height); panel padding 32px; softer layered shadows; light page #eef0f6 with a tonal canvas, muted text darkened, control outline darkened to keep 3:1; dark page/surface/sidebar re-stepped.
- Components: Card, WidgetFrame (no divider, larger bold title, roomy padding), Button (pill, 44px md, bolder), NavLink (pill, inverted active state, 44px), Sidebar spacing, header height and account chips, notification bell, PageHeader.
- `/dev/shell` (dev only, 404 in production): static sample dashboard inside the real AppShell so both themes can be reviewed without an account.
- No change to data, permissions, privacy, layouts, copy or routes.

## Deviations needing Ward's OK

- Supersedes redesign decision 16 radii (cards 12-16 px, controls 6-10 px) and the "plain system font" fallback. Token test updated accordingly. `docs/design/design-decisions.md` supplement not edited here; add a line after approval.
- New dependency @fontsource-variable/plus-jakarta-sans 5.3.0 (self-hosted font; accent colour untouched).

## Screenshots

/mnt/project-files/wip/UX-makeover/{before,after}-{light,dark}.png (1440x900, `/dev/shell`).
Not shown: sidebar active item (the preview path is not a nav destination) and real widgets.

## Tests run locally

design-tokens: 69 pass. web: tsc clean; eslint clean on touched dirs; vitest shell/ui/dashboard + design-token and RTL guards: 287 pass. Full suite runs on CI.

## Stage 2 candidate order (after Stage 1 approval)

1. Home dashboard (real widgets: stat, list, calendar, Ora card)
2. Calendar 3. Tasks and chores 4. Shopping and meals 5. Settings and account 6. Sign-in/auth 7. Child view and wall display 8. Empty states, dialogs, toasts, mobile nav.

## Review follow-up (reviews/steps/UX-makeover-review.md: PASS, 0 BLOCKER/HIGH)

Fixed: tracking reset for ar/fa/he and no font-smoothing override (M2, L2); /dev/shell production-gate test and WidgetFrame test (M1/M3); stale comment (L1); synthetic name (L5).
Accepted for Stage 2: real dashboard grid rows/gap and widget minimum heights (M1), mobile nav / context switcher alignment (M4, so this must not ship to production alone), 44px touch targets on remaining controls (L3), font metrics fallback (L4).

## Direction chosen by Ward (2026-11-26): C, Family Hub

Answers: keep purple default accent; slim icon rail is the default sidebar state (still expandable, saved per device); flat cards with a hairline edge (20px corners, near-zero shadow); greeting centred on the dashboards only.
Built: dark floating rail in both themes with an accent-filled active item; teal-slate neutrals; flat card tokens; `PageHeader centered`; `link-inline` (links inside sentences) and `link-action` (standalone links and text buttons become soft pills) applied to 303 occurrences by a codemod (34 inline, 269 action; the split is "preceded by a space expression in the same sentence"); e2e updates for the new default rail and the token-colour check (both themes allowed because the rail forces dark).
Open: some of the 269 action links may deserve a different treatment or sit awkwardly in tight rows; check page by page in Stage 2. Real pages not screenshotted (needs an account and database); preview at `/dev/shell`.
