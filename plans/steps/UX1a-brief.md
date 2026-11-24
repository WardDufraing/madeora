# UX1a — Redesign design foundations

Branch: `feat/redesign-design-foundations`. Source: `plans/steps/UX00-redesign-plan-brief.md` §3A and §4, `docs/design/dashboard-ux-ui-redesign.md` Decisions 14–17, 21–24, 52, adaptive creation, 54/59/71.
Model: Sonnet (tokens, restyle, UI primitives only; no auth, RLS or data).

## Done condition
Tokens carry the approved depth, radius, spacing, motion, canvas and priority roles; Card, Button and fields use them; the shared primitives exist, are keyboard and screen-reader tested; nothing else in product behaviour, data or permissions changes.

## Scope delivered
- **Tokens** (`packages/design-tokens`): radius control 8 px / card 14 px / overlay 20 px; four elevation roles `raised`, `overlay`, `inset`, `selected` per theme (`shadow-raised` replaces `shadow-card`); spacing roles (`grid-gap`, `widget-padding`, `panel-padding`, …) that shrink below 40 rem; motion travel/press-scale tokens, all zero under reduced motion; neutral tonal `--md-canvas` replaces the accent-based atmosphere (page background only, solid fallback kept); `priority-high/medium/low` colour tokens reusing the status tones.
- **Restyle:** Card (raised, token padding), Button (press feedback, raised secondary), text/select/textarea (inset), Dialog radius.
- **Icons:** `MoreVerticalIcon`, `SearchIcon`, `PlusIcon` (custom SVG, README updated).
- **Primitives** (`apps/web/src/components/ui`): `Dialog` gains `size` (compact / default / large / side drawer / bottom sheet) and a `dirty` unsaved-changes question inside the same dialog; new `CreateDialog` (shared quick-create shell: Cancel then Save, busy state, form error, focus return), `Popover`, `OverflowMenu` (menu keyboard model), `AdaptiveSwitcher` (chips up to 5 and on wide screens, searchable picker beyond or on narrow, + New affordance, selection not by colour alone).
- Dev preview page (`/dev/components`) shows the new roles and primitives.

## Decisions taken (reversible)
- Canvas gradient stops fixed so muted text keeps 4.5:1 (tested). Atmosphere accent glow removed because Decision 21 says neutral.
- Press feedback and slide animations read motion tokens, so reduced motion needs no extra code.
- Popover and menu are absolutely positioned (no collision flipping yet); the calendar preview phase (UX3) can extend.
- Priority tokens are aliases of status tones, no new palette.

## Not in this phase
Visual baseline screenshots (no running Supabase-backed app in this environment; `/dev/components` now exists for them), shell/nav (UX1b), widget shell (UX2a), wiring `CreateDialog` into Tasks/Calendar (UX3/UX4/UX6), menu entries.

## Local checks (format, lint, typecheck, relevant tests only)
Prettier clean; eslint on `components/ui` + `app/dev` clean; `tsc` clean; vitest: ui, dashboard, shell, dev page, token-only guard (206 tests) + design-tokens (69) + icons (69) pass. Full suite and build run on CI.

## Rollback
Pure frontend and token change; revert the PR. `shadow-card` utility no longer exists (renamed).
