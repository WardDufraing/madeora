# UX tasks completed rows: independent review

- **Branch:** `feat/ui-tasks-completed` vs `origin/main` (one file: `apps/web/src/components/tasks/task-list.tsx`, +3/-2).
- **Change:** Completed-section rows drop `opacity-80` and `shadow-raised` is applied only to rows outside that section.

**Verdict:** `PASS`

No BLOCKER, HIGH or MEDIUM findings.

## Explicit checks

- **Requirements:** no product behavior change. Only presentation of rows already in the Completed section. Specification untouched.
- **Contrast (light):** `fgMuted #586368` on `surface #ffffff` is about 6:1. Primary text is higher. Both are asserted at 4.5:1 or better on every surface by `packages/design-tokens/src/tokens.test.ts`. With `opacity-80` the effective muted colour blended toward the page and fell below that guarantee, so removing it restores the tokenised ratio.
- **Contrast (dark):** `fgMuted #9aa7ad` on `surface #141b1f` is about 7:1, again token-tested.
- **Quieter yet distinct:** completed rows keep the strikethrough, the `text-fg-muted` title and the explicit "Completed" status text, and they sit in their own section. The `raised` shadow is very faint (light `0 1px 2px` at 0.05, dark at 0.3), so the lift difference is subtle, mainly in dark. That is acceptable: depth is documented as never carrying state, and state is carried by text and strikethrough.
- **Forced colors:** box shadows are removed in forced-colors mode, and opacity was the only previously visible quieting there. The row border, strikethrough and "Completed" label remain, so state is still conveyed without colour or depth. Selected and retained rows keep `forced-colors:border-[Highlight]`.
- **Accessibility:** no change to semantics, focus, names or checkbox. No colour-only signal. Opacity removal also removes the dimming of the focus ring and checkbox in the section, a small improvement.
- **Tests:** no unit, component or e2e test asserts `opacity-80` or `shadow-raised` (grepped `apps/web` and `tests/e2e`; `opacity-80` has no other use in `apps/web/src`). Nothing needs updating. No new test was added; a class assertion would test implementation, so the gap is acceptable.
- **Cross-Home isolation, permissions, secrets, validation, migrations:** not affected.
- **Performance and maintainability:** drops a compositing-affecting opacity layer; the inline comment explains the intent. The empty-string ternary matches the existing `cx` style in the file.

## Findings

### LOW

1. `task-list.tsx` around line 299: the shadow-only distinction is faint in light theme (row border `#e4e8ea` on page `#f0f2f4`, no shadow), so completed rows read as flat cards. Remediation, optional: if the owner wants a stronger "quiet" cue, use a muted surface token or dashed border rather than opacity. No action needed to merge.

## Remaining risks and test gaps

- No visual or forced-colors screenshot check was run; reasoning is from tokens and CSS only.
- No automated test covers the Completed section's appearance.
