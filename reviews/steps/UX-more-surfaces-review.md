# Independent review: feat/ui-more-surfaces

Scope: `git diff origin/main...HEAD`, 14 files under `apps/web/src/components`, 17 class-string lines, no logic changes.

## Verdict: PASS

No BLOCKER or HIGH findings. There is one MEDIUM finding and three LOW findings, all non-blocking.

## Findings

### MEDIUM-1: Edit-reward form is now a raised panel nested inside a raised list

- Files: `points/reward-actions.tsx:261` (`RewardForm`), `personal-points/personal-reward-actions.tsx` (`PersonalRewardForm`).
- `RewardForm reward={reward}` renders inside each `<li p-4>` of the catalog `<ul … shadow-raised>` (`points/rewards-page.tsx:259`, `personal-rewards-page.tsx:159`). The edit form therefore gets `shadow-raised` and 24px padding inside an already raised list that has 16px padding.
- Impact: double elevation and heavier nesting. At 320px the form has about 16 + 24 px of inset per side, which squeezes the fields. The nesting existed before (bordered `p-4` form in a bordered list), but this change makes it more visible.
- Remediation (follow-up, not blocking): give the edit form a `className` or variant, or `bg-surface-sunken` without shadow, when it is rendered inside a list item. The create form (`rewards-page.tsx:181`) is top level and correct.

### LOW-1: Notice banner now carries `shadow-raised`

- File: `account/security-review-banner.tsx:13`.
- It is an `<aside>` notice at the top of the app layout, not a content card. It is the only notice-type element converted. The sibling notice banners keep flat styling: `google-calendar/google-warnings.tsx`, `google-event-page.tsx` and `google-event-actions.tsx` (warning and danger borders), and `notifications/failure-alert.tsx`.
- Impact: inconsistent notice treatment, and its padding goes from 16 to 24px.
- Remediation: revert it to `p-4` without shadow, or convert all notice banners in one change.

### LOW-2: Class order

- The banner has `shadow-raised text-body`, while `Card` uses `text-fg shadow-raised`. Prettier check passes, so there is no tooling issue.

### LOW-3: Flat surfaces remain (consistency gaps)

These are bordered `bg-surface` blocks still flat in the touched modules:

- `pets/pets-view.tsx:69` (pet cards, `card-lift`) and `pets/pet-care-widget-body.tsx:52`.
- `meals/meal-copy-week.tsx:169`, `meal-settings.tsx:84`, `meal-series-list.tsx:67` and `meal-print.tsx:138`. The print one is intentionally flat.
- `notifications/notification-list.tsx:353` (list items).
- `personal-points/personal-points-page.tsx:68` and `points/points-page.tsx:39` (balance tiles), and `points/leaderboard-page.tsx:161`.
- `google-calendar/google-event-actions.tsx:344`.
- Intentionally flat: `bg-surface-sunken` info blocks, the overlay (`shadow-overlay`), and `-danger`/`-warning` bordered banners.
- `meals/meal-planner.tsx:179` was already converted on main.
- Suggest tracking these in a later surfaces step. Notably, the balance tiles sit right beside the raised ledger lists.

## Explicit checks

- Unintended matches
  - `calendar/event-form.tsx` and `google-calendar/google-event-form.tsx` preview panels are top-level inside forms, not nested raised.
  - `meals/meal-shopping-transfer.tsx` is a `<fieldset>` rendered directly by `meals-page.tsx` with no raised ancestor. Raised depth plus padding is fine, and the fieldset and legend semantics are untouched.
  - `points/point-preferences.tsx` and `notifications/notification-settings.tsx` are `<form>` roots, standalone.
  - `pets/pet-care.tsx:78` is a list item, not inside the `<Card>`.
  - Divide-y lists: shadow is on the `ul`, with no raised parent. `personal-points-page` and `points-page` lists sit in plain sections.
  - Only MEDIUM-1 and LOW-1 are mismatches.
- Requirements and isolation: class-only. No data, permission, Home-scope or secret surface is touched.
- Consistency: recipe matches `ui/card.tsx` (`p-widget-padding shadow-raised`). Both tokens exist in CSS (`--md-space-widget-padding` = 1.5rem, `--md-shadow-raised`, with dark overrides).
- 320px: fixed 24px padding is the same as Card. Only the nested edit form in MEDIUM-1 is tight. Divide-y lists keep their li padding.
- Forced-colors: the `border border-line` is retained on every changed element, so the edge survives when shadows are dropped. The same rationale as the Card docstring applies.
- Accessibility: no semantic, role, label or focus changes. Shadow is not the sole cue because the border remains.
- Performance: none.
- Tests: no test asserts the changed classes. I ran vitest on points, personal-points, pets, meals, calendar, account, notifications and google-calendar: 13 files, 154 tests, all passed. `prettier --check` on the 14 files passed. I did not run lint, typecheck or build, and I did not run any visual or Playwright check.
- Product specification: untouched.

## Remaining risks and test gaps

- No visual regression or axe coverage for the new depth.
- The nesting in MEDIUM-1 is not asserted anywhere.

## Follow-up

MEDIUM-1 and LOW-1: the reward forms (nested in raised lists) and the security notice banner were reverted to flat `p-4`. LOW-3 (flat `p-3` tiles and list items such as pets, meal rows, balance tiles) is deliberate: compact items keep their size; a later pass can decide on a tile style.
