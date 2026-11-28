# UX account surfaces independent review

Branch: `feat/ui-account-surfaces` (diff against `origin/main`, 5 files, 5 lines changed).
Reviewer: independent agent, fresh context. Scope: the class-only change `p-4` to
`p-widget-padding shadow-raised` on five top-level panels. The product specification was not read.

## Verdict: PASS

No BLOCKER or HIGH findings. One MEDIUM and three LOW findings; none blocks PR readiness.

Checks I ran myself:

- `prettier --check` on the five changed files: clean.
- `vitest run src/components/vacations src/components/invitations src/components/dashboard`:
  11 files, 182 tests, all pass.
- The diff was read in full. No source file was edited and nothing was committed.

## Findings

### MEDIUM

1. **Invite "created" panel is a raised surface nested in a raised Card.**
   `apps/web/src/components/invitations/invite-form.tsx:315-318`. `InviteForm` is rendered inside
   `<Card title={t("createTitle")}>` (`apps/web/src/app/(app)/homes/[homeId]/invitations/page.tsx:117`),
   and `Card` is already `p-widget-padding shadow-raised`. The result panel now has a second shadow
   and a second 1.25-1.5rem inset inside the card's own padding, so on a 320px viewport the inner
   text column loses roughly 4 x widget-padding of width. Before the change it was a flat bordered
   inset. Remediation: leave this one flat (`p-4` or `p-3`, no shadow, optionally `bg-surface-sunken`)
   as a nested surface, or call it out as intentional.

### LOW

2. **Version rows are raised inside the Dialog.** `apps/web/src/components/dashboard/version-history.tsx:202`.
   `VersionHistory` renders in `Dialog` (`ui/dialog.tsx:152`, `bg-surface-elevated`, `shadow-overlay`,
   inner `p-panel-padding`). Raised cards inside an overlay mean two paddings plus shadows, and the
   shadow-raised depth is lost against the elevated background in dark theme. Functionally fine
   (border retained, list semantics `ol > li > article` unchanged). Consider a flat row inside dialogs.
3. **Forms in `vacations-page`/`absences-page` are siblings, not nested.** Verified
   `NewVacation`/`NewAbsence` sit at page level (`vacations-page.tsx:178`), so raising them is
   consistent with `Card`. No finding; recorded for completeness. Inside them,
   `new-vacation.tsx:195` keeps a flat `p-3` bordered fieldset, which is the correct nested treatment.
4. **Nit: class order.** The five lines emit `shadow-raised text-fg` while `ui/card.tsx` and merged
   work use `text-fg shadow-raised`. No Tailwind prettier plugin is configured, so prettier passes.
   `dashboard-editor.tsx:1039` and `version-history.tsx:202` only.

## Requested checks

- **Nesting in raised surfaces:** only the two cases above (findings 1 and 2). The three other
  panels (`new-vacation`, `absence-forms`, `EditorPanel`) are top level.
- **react-grid-layout and Motion:** `EditorPanel` (`dashboard-editor.tsx:1028-1046`) is rendered in a
  `grid gap-4 lg:grid-cols-2` block (line ~740) above the arrange area, in normal flow. It is not a
  child of the RGL container or its drag handle area, has no transform, no Motion wrapper and no
  `position`/`z-index`, and does not overlap the grid. The `shadow-raised` is a paint-only box-shadow,
  so it cannot interfere with drag/resize. The sticky toolbar (`z-10`, line 667) was already raised and
  is unchanged; the panels scroll beneath it as before. No conflict with the animation strategy.
- **320px:** the panels are `flex flex-col` in single-column flow (editor grid is `lg:grid-cols-2`),
  so the extra padding costs width only; text wraps. Only the nested invite panel (finding 1) is tight.
  There is no horizontal overflow risk from `shadow` itself.
- **forced-colors:** `box-shadow` is dropped in forced-colors mode, but each panel keeps
  `border border-line`, which the UA maps to a visible system color, so the surface edge remains.
  Same as `Card`. No finding.
- **Accessibility:** semantics unchanged (`section`/`article`/`form` with labels, test ids). Padding
  and shadow are non-interactive; focus rings of inner controls are not clipped because no overflow
  is introduced. Contrast is unchanged (same `bg-surface`/`text-fg` tokens).
- **Tests:** no test asserts the changed class strings (`p-4` is not referenced in tests); the 182
  related tests pass. No new test needed for a class-only change; a visual or axe check is
  already covered by existing suites.

## Remaining flat surfaces in these modules

Bordered `bg-surface` / `bg-surface-sunken` surfaces without `shadow-raised`:

- `vacations/vacation-detail-page.tsx:174,184` (divided lists), and list items at 82 (`p-4`)
- `vacations/absences-page.tsx:81` (divided list), item at 85 (`p-4`)
- `vacations/vacations-page.tsx:132,193,206` (divided lists), item at 82; `:120` sunken note
- `vacations/review-list.tsx:62` (divided list)
- `vacations/vacation-state-note.tsx:57`, `vacations/impact-preview.tsx:35` (sunken, nested notes;
  should stay flat)
- `vacations/new-vacation.tsx:195` (nested fieldset; should stay flat)
- `dashboard/widget-gallery.tsx:143` (`p-3`, inside a Dialog), `dashboard/stack-editor.tsx:61`
  (`p-3` rows), `dashboard/layout-preview.tsx:76` (sunken thumbnail),
  `dashboard/home-view-controls.tsx:189` (sunken bar, `border-border`)
- `dashboard/version-history.tsx:185` is a warning panel inside the dialog (flat, intentional)
- Invitation list/request components use `bg-surface` in places (`invitation-list.tsx`,
  `join-request-list.tsx`, `my-join-requests.tsx`, `join-invitation.tsx`, `join-code-form.tsx`);
  not audited line by line since they are outside this diff, and most are rendered inside `Card`.

Divided lists (`divide-y`) rendered as top-level page sections in vacations are the main candidates
for a follow-up if the whole module should read as raised.

## Explicit checks

| Check                | Result                                |
| -------------------- | ------------------------------------- |
| Requirements         | Matches Card recipe; scope class-only |
| Cross-Home isolation | N/A, no logic changed                 |
| Permissions          | N/A                                   |
| Secrets              | None                                  |
| Input validation     | N/A                                   |
| Migration safety     | N/A, no migrations                    |
| Test coverage        | Existing tests pass; none needed      |
| Accessibility        | No regression; see above              |
| Performance          | Negligible (box-shadow paint)         |
| Maintainability      | Fine; nit on class order (finding 3)  |

## Remaining risks and test gaps

- Visual regression of the nested double-raised cases was not checked in a browser (no screenshots
  were taken); the assessment is from code reading.
- No automated check guards against nesting raised surfaces.

## Follow-up

MEDIUM: the invitation-created panel stays flat (nested in a Card). LOW: version-history rows stay flat inside the dialog; class order in the dashboard editor fixed to match Card. The vacation `divide-y` lists now also use `shadow-raised`. Remaining `p-3` rows and sunken notes are deliberately left compact/flat.
