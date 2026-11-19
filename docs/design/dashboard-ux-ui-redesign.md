# Madeora — Dashboard UX/UI Redesign Plan

**Status:** Visual direction approved (Playful Precision); widget UX decisions pending; requires visual review before implementation  
**Created:** 2026-11-19  
**Scope:** Personal and Home dashboards, dashboard editor, widget gallery, responsive shell and visual system.  
**Not in scope:** Rebuilding completed business logic or changing authorization/privacy rules.

## Evidence and limitations
Reviewed the authenticated deployed personal dashboard's browser-readable structure on 2026-11-19, plus the repository README and user-story overview. This is **not** a screenshot-level visual audit: spacing, colors, animations, and the widget-add/edit panel were not directly observed. Treat all editor-specific proposals below as hypotheses until a screenshot or interactive walkthrough is reviewed.

Visible page includes a large module sidebar (Dashboard, Calendar, Tasks, Chores, Meals, Shopping, Habits, Goals, Pets, Photos, Integrations, Settings, Help), a Personal/Home context switcher, Dashboard > Customize, Welcome, Quick Actions, Notifications, Personal Tasks, Home Chores, Upcoming Appointments, and Ora. Multiple widgets currently show empty states. Quick Actions largely navigate to other pages.

## Product experience goal
**Madeora should feel like a calm, personal daily command center, not a collection of administrative modules.** In 5 seconds, users should know what matters today, what they can do next, and where to go. Customization must be discoverable but never required for a useful default dashboard.

## Approved visual direction — Playful Precision (2026-11-19)
The product owner selected **C: Polished Productivity** combined with **B: Friendly & Playful**. This is the guiding design identity, not a mandate to copy any inspiration image. The foundation is structured, efficient and precise; personality appears through restrained pastel accents, friendly iconography, subtle motion, warm copy and thoughtful empty states. Avoid both corporate analytics aesthetics and childish decoration.

**Design principles:** hierarchy before decoration; useful at a glance; customization without complexity; coherent across modules; delightful but never distracting. Retain accessibility, light/dark support, and personal/Home privacy boundaries.

## Proposed visual direction
- Approved direction: **Playful Precision** — polished productivity with a friendly, lightly playful character.
- Strong hierarchy: compact greeting + date, one primary daily-focus region, then useful widgets.
- Clear type scale, consistent card radii, spacing, elevation and icon treatments through existing design tokens. No arbitrary one-off colors.
- Light and dark themes with accessible contrast, subtle accent use and restrained motion; support reduced-motion.
- More purposeful use of whitespace; avoid many identical full-height cards and nested borders.
- Distinguish summary, actionable, and decorative widgets visually, without making everything a card.
- Design for empty, sparse, and populated states; avoid walls of 'nothing to show'.

## Proposed dashboard information architecture
1. **Top bar:** active Personal/Home context, page title, compact notifications, quick-create button, avatar. Keep context explicit; never leak private information into Home.
2. **Daily overview:** greeting/date plus meaningful today summary (next event, due task, important Home activity) with conditional content. Do not render a large empty welcome widget.
3. **Priority area:** upcoming events and today's tasks in useful compact or expanded variants; one-click complete/add where permitted.
4. **Secondary grid:** shopping, chores, habits, meals, goals, pets, photos, and other context-eligible widgets, based on preferences.
5. **Ora:** integrated, contextual, dismissible assistant affordance; avoid competing permanent panels and floating controls. Respect existing permission and proactive settings.
6. **Navigation:** group sidebar items by intent (Today, Plan, Home, Personal, Other); keep key destinations visible, secondary destinations collapsible. Test before replacing the current navigation.
7. **Home vs Personal:** retain independent layouts and settings; make switching easy and recognizable; Home widgets respect membership and permissions.

## Approved decision 2 — Hybrid widget customization (2026-11-19)
**Decision: C — Hybrid customization.**

- In normal dashboard mode, each widget may expose a subtle overflow menu for widget-specific settings, without entering dashboard edit mode.
- A dedicated **Edit dashboard** mode handles adding, removing, rearranging and resizing widgets.
- Normal mode keeps widget positions locked, preventing accidental movement, particularly on touch devices.
- Widget configuration and dashboard geometry are separate interaction concerns. Configuration changes must not silently reposition widgets.
- The exact save/cancel semantics for widget settings versus layout edits remain to be decided.
- Widget menus must be keyboard-accessible and must respect permissions and context.

## Approved decision 3 — Combined widget adding (2026-11-19)
**Decision: D — Combined approach.**

- In dashboard edit mode, **Add widget** opens a searchable, categorized slide-out gallery with previews, eligibility states, and clear add actions.
- Inline **Add widget here** affordances in available grid positions let users place widgets intentionally; these may invoke the same gallery scoped to a target position.
- Both entry points use the same widget catalog, permission checks, configuration rules, and placement logic.
- Desktop uses a side panel keeping the grid visible; mobile may use a full-screen sheet to preserve usable space.
- After adding, show the new widget clearly and avoid unexpected reshuffling. Exact placement and collision behavior remain to be decided.
- Do not crowd normal dashboard mode with permanent empty-slot buttons; inline placement affordances appear in edit mode.

## Approved decision 4 — Hybrid widget resizing (2026-11-19)
**Decision: C — Hybrid resizing.**

- In dashboard edit mode, users may drag resize handles; width and height snap to supported grid increments rather than arbitrary pixels.
- The widget menu also offers named size presets, so resizing does not depend on precise pointer input.
- Each widget type defines supported minimum/maximum dimensions and sensible presets based on content.
- The grid shows a clear resize preview and collision behavior; never silently overlap widgets or lose content.
- Provide keyboard and touch-accessible size selection. Hide resize handles in normal mode.
- Preserve responsive behavior and saved layouts across screen sizes; mobile may map desktop dimensions to supported single-column variants.
- Exact grid column count, snap increments and collision/reflow rules remain implementation decisions to validate in prototypes.

## Approved decision 5 — Smart reflow with preview (2026-11-19)
**Decision: C — Smart reflow with preview.**

- During drag, resize, or add-at-position interactions, show a live placement preview indicating the proposed positions of all affected widgets before commit.
- Reflow only widgets that must move to resolve collisions; preserve other positions wherever feasible.
- Never overlap widgets, silently discard them, or cause unexpected global rearrangement.
- Support undo of a placement change during the edit session; Cancel restores the previously saved layout.
- Use deterministic placement and collision rules so the same action produces the same result.
- Make the preview legible for pointer, keyboard and touch interactions; provide non-drag alternatives.
- Validate edge cases for mixed sizes, gaps, adding near grid edges, and responsive breakpoints.
- Exact collision algorithm, animation, and save semantics are implementation details to prototype and test.

## Approved decision 6 — Hybrid saving with recoverable drafts (2026-11-19)
**Decision: C — Hybrid saving with recoverable drafts.**

- Dashboard edit mode maintains a draft of layout changes, including moves, resizes, additions and removals, without publishing them to the active dashboard.
- Draft changes are autosaved for recovery from accidental refresh, tab closure or interrupted sessions; **Done** explicitly commits the draft as the active layout, and **Cancel** discards the draft and restores the last committed layout.
- Display clear **Saving draft / Draft saved / Save failed / Unsaved changes** feedback as appropriate. Never claim a draft is safely stored until persistence succeeds.
- On reopening edit mode with a recoverable draft, offer **Resume draft** or **Discard draft**; do not silently replace the committed dashboard.
- Warn before navigating away when there are changes not safely persisted. Recoverable draft storage must be scoped to account and Personal/Home context, permission-checked, and never leak another context's layout.
- Provide undo/redo within the edit session where practical. **Done** must handle commit failures without losing the draft or falsely showing success.
- Define a safe multi-device edit conflict strategy before implementation (version checks and a recovery choice rather than silent last-write-wins).
- Widget-specific configuration from normal mode is separate from dashboard layout editing; whether it saves immediately or requires confirmation is a later decision.
- Draft persistence mechanism, expiration/cleanup policy and offline behavior require engineering review; do not assume browser-local storage is appropriate for sensitive metadata.

## Approved decision 7 — Smart visual widget gallery (2026-11-19)
**Decision: C — Smart visual gallery.**

- The widget gallery presents visual preview cards, not merely a text list. Each card explains the widget's purpose and offers a clear Add action.
- Provide search, meaningful categories, a contextual **Recommended** section, and a clear **Already added** state.
- Recommendations use the active Personal/Home context, eligibility, available permissions and useful defaults; avoid intrusive behavioral tracking.
- Show ineligible widgets only when useful for discovery, with a clear explanation; never offer actions the user cannot perform.
- Preview data should be synthetic or permission-safe and visibly distinguishable from real user data.
- Support keyboard and screen-reader navigation, responsive card layouts, and efficient rendering for large catalogs.
- The approved combined gallery + inline add-at-position workflow remains unchanged.
- Recommendation ordering, category taxonomy, duplicate-instance policy and exact preview format remain to be refined.

## Approved decision 8 — Hybrid widget settings (2026-11-19)
**Decision: C — Hybrid widget settings.**

- Every configurable widget exposes a consistent, unobtrusive settings entry in its overflow menu, including in normal dashboard mode where permissions allow.
- Simple, frequently changed options open in a compact anchored popover, without requiring dashboard edit mode.
- Complex settings open in a dedicated side panel with a live preview; on narrow screens use an accessible full-screen sheet.
- Use consistent field labels, grouping, help text, validation, loading/error feedback, and keyboard/focus behavior across widget types.
- Advanced configuration respects active Personal/Home context, available calendars, widget filters, time zones, and permissions. Never expose unauthorized data in preview.
- Configuration changes must not silently alter widget geometry or reposition other widgets.
- Whether changes save immediately or use Apply/Cancel is a separate decision; unsaved widget settings must not be confused with recoverable dashboard layout drafts.
- Decide which settings qualify as quick versus advanced during the widget-by-widget audit.

## Highest-priority redesign: widget customization
### Normal mode
- Widgets cannot accidentally move.
- **Approved:** each widget has a discreet configuration menu usable without entering dashboard edit mode.
- Visible **Edit dashboard** entry in header; unobtrusive **Add widget** entry or empty-slot affordance where relevant.
- Widget content supports direct actions where permissions allow; widget title opens the full module.

### Edit mode
- **Approved:** adding, removing, rearranging and resizing widgets happens in a dedicated edit mode.
- Clear visual transition: edit toolbar with **Add widget**, **Undo**, **Reset layout**, **Cancel**, **Save**.
- Visible drag handles and resize controls only in edit mode; precise drop indicators and **approved smart reflow preview**: move only necessary widgets and show all changes before drop.
- **Approved:** hybrid resizing combines drag handles snapped to grid increments with named size presets; enforce widget-specific size constraints.
- **Approved:** autosave recoverable editing drafts, with explicit Done to commit and Cancel to discard. Confirm destructive reset; distinguish removing a widget from deleting underlying data.
- Keyboard-accessible Move up/down/left/right and size controls, plus touch-friendly alternatives to drag.
- On save, persist per account and dashboard context; show success and restore previous layout on error. Prevent overwriting edits across devices without a conflict strategy.

### Widget gallery
- **Approved:** smart visual gallery with previews, categories, search, contextual recommendations and already-added indicators.
- **Approved:** combined gallery and inline add-at-position workflow in edit mode.
- Open as a desktop side panel and mobile full-screen sheet.
- Search; category filters (Today, Planning, Home, Personal, Lifestyle); contextual eligibility and permission messaging.
- Each widget gets a meaningful preview with sample content, concise description, size options, and clear **Add** action.
- Show **Added** state, allow multiple instances only for widgets that support meaningful independent configurations.
- Immediately place newly added widgets in a visible, predictable position, with highlight and optional configuration step.
- Gallery should not force a multi-step setup for simple widgets; advanced filters/configuration remain optional.
- Empty widget slots may offer **Add widget here** in edit mode.

### Widget configuration
- **Approved:** hybrid configuration — compact popovers for simple settings, dedicated side panel with live preview for advanced settings.
- Consistent overflow menu: Configure, Resize, Move, Remove.
- Prefer simple inline settings; use a side sheet for advanced options with live preview.
- Respect widget-specific filters, time zones, Home permissions, and data visibility.
- Preserve existing widget settings when moving/resizing. Removal should not delete source records.

## Empty-state and content improvements
- Replace repetitive empty cards with compact, useful prompts: 'No events today' + Add event, or a subtle collapsed summary.
- Hide or shrink low-value empty widgets according to explicit user preference; never silently remove a configured widget.
- Prioritize due-soon items, not every possible metric.
- Replace navigation-only Quick Actions with actual creation actions (task, event, shopping item), using existing safe flows.
- Provide sensible curated default layouts for Personal and Home, plus a lightweight **Choose your own** starting option.
- Onboarding should offer customization but not require it.

## Responsive and accessibility requirements
- Desktop: multi-column grid with consistent alignment and restrained maximum reading width.
- Tablet: adaptive two-column layout where possible.
- Mobile: prioritized single-column cards, touch-friendly actions, compact navigation and full-screen widget gallery.
- Household display: separate device-specific UI; do not accidentally reuse private dashboard content.
- Meet WCAG 2.2 AA targets where applicable: keyboard interaction, focus visibility, screen-reader announcements, contrast, drag alternatives, reduced motion, accessible dialogs.
- Localized Dutch/English copy and long-text handling.

## Implementation workstreams (proposed order)
| Phase | Priority | Deliverable | Exit criteria |
|---|---|---|---|
| 0. Audit | P0 | Screenshots of desktop/mobile, edit mode, gallery, populated and empty widgets; inspect existing code/design tokens | Baseline and constraints recorded |
| 1. Design direction | P0 | 2–3 visual concepts and selected design system refinements | Owner approves direction |
| 2. Dashboard shell | P0 | Header, context switcher, hierarchy, sidebar grouping, responsive grid | Personal/Home privacy and navigation regression tests pass |
| 3. Widget editor | P0 | Edit mode, drag/resize, undo/cancel/save/reset and accessible alternatives | Layout changes persist and revert correctly |
| 4. Widget gallery | P0 | Search, previews, categories, add states, predictable placement | Add widget in a few obvious actions |
| 5. Widget content | P1 | Compact/full variants, useful empty states, direct actions, consistent settings | Sparse and populated dashboards both look intentional |
| 6. Ora integration | P1 | Contextual assistant placement and states | No duplicate competing affordances |
| 7. Polish and validation | P1 | Theme, motion, mobile, accessibility, visual regression and usability tests | Owner sign-off across screen sizes |

## Suggested acceptance scenarios
- A new user understands the dashboard without configuring anything.
- A user can discover how to add a widget, preview it, add it, resize/reorder it, and save.
- A user can cancel an edit session without losing their previous layout.
- A user can restore a removed widget without losing its underlying task/calendar data.
- A keyboard-only or touch user can complete the same layout operations.
- Personal and Home layouts remain separate, and unauthorized Home information never appears.
- Empty accounts look purposeful; populated accounts remain scannable.
- Changes survive reload and work across desktop/mobile without overlapping cards.
- Dark/light themes, NL/EN text, loading/error/offline states are reviewed.

## Decisions to make with the product owner
- Visual direction: **DECIDED — Playful Precision (polished productivity + friendly/playful)**.
- Sidebar: persistent grouped navigation vs compact rail + expandable drawer.
- Grid sizing: **DECIDED — hybrid snap-to-grid drag resizing plus named presets**; exact grid geometry pending.
- Collision behavior: **DECIDED — smart reflow with live preview, minimal necessary movement and undo**.
- Add flow: **DECIDED — combined slide-out gallery and inline add-at-position affordances**; exact placement behavior remains undecided.
- Gallery presentation: **DECIDED — smart visual gallery with contextual recommendations and preview cards**.
- Save semantics: **DECIDED — autosaved recoverable draft, Done commits, Cancel discards**; normal-mode widget configuration save behavior remains open.
- Empty widgets: compact vs optionally hidden.
- Widget configuration: **DECIDED — hybrid quick settings popover + advanced side panel with preview**; configuration save semantics pending.
- Ora: inline summary vs floating launcher vs both with clearly distinct roles.

## Engineering guardrails
Read `docs/product/Project-entry.md`, `docs/product/Modules.md`, `docs/product/Project-specification.md`, `docs/design/design-decisions.md`, `CLAUDE.md`, and current dashboard/widget implementation before coding. Binding product specification is read-only; this document is a proposed redesign plan, not authorization to contradict it. Reuse `packages/design-tokens`, `packages/icons`, and existing dashboard persistence where possible. Avoid breaking existing user layouts; plan migration/versioning if widget geometry or schema changes. Add Playwright interaction tests and visual snapshots, plus RLS/privacy checks where data access is touched.

## Next action
Obtain screenshots or a live interactive review of **normal dashboard**, **edit dashboard**, **widget gallery**, and **widget configuration** at desktop and mobile widths. Refine this plan based on actual visuals and implementation details before starting code.
