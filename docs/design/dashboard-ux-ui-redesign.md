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

## Highest-priority redesign: widget customization
### Normal mode
- Widgets cannot accidentally move.
- **Approved:** each widget has a discreet configuration menu usable without entering dashboard edit mode.
- Visible **Edit dashboard** entry in header; unobtrusive **Add widget** entry or empty-slot affordance where relevant.
- Widget content supports direct actions where permissions allow; widget title opens the full module.

### Edit mode
- **Approved:** adding, removing, rearranging and resizing widgets happens in a dedicated edit mode.
- Clear visual transition: edit toolbar with **Add widget**, **Undo**, **Reset layout**, **Cancel**, **Save**.
- Visible drag handles and resize controls only in edit mode; precise drop indicators, collision feedback, no surprising reshuffles.
- Use a predictable responsive grid; support fixed widget size presets (small, medium, large) rather than unrestricted resizing initially.
- Unsaved changes must be cancelable. Confirm destructive reset; distinguish removing a widget from deleting underlying data.
- Keyboard-accessible Move up/down/left/right and size controls, plus touch-friendly alternatives to drag.
- On save, persist per account and dashboard context; show success and restore previous layout on error. Prevent overwriting edits across devices without a conflict strategy.

### Widget gallery
- Open as a desktop side panel and mobile full-screen sheet.
- Search; category filters (Today, Planning, Home, Personal, Lifestyle); contextual eligibility and permission messaging.
- Each widget gets a meaningful preview with sample content, concise description, size options, and clear **Add** action.
- Show **Added** state, allow multiple instances only for widgets that support meaningful independent configurations.
- Immediately place newly added widgets in a visible, predictable position, with highlight and optional configuration step.
- Gallery should not force a multi-step setup for simple widgets; advanced filters/configuration remain optional.
- Empty widget slots may offer **Add widget here** in edit mode.

### Widget configuration
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
- Grid: fixed presets vs fully freeform placement.
- Add flow: gallery side panel vs modal, and default placement behavior.
- Save semantics: explicit Save/Cancel vs autosave with undo (still undecided; hybrid mode does not settle persistence).
- Empty widgets: compact vs optionally hidden.
- Ora: inline summary vs floating launcher vs both with clearly distinct roles.

## Engineering guardrails
Read `docs/product/Project-entry.md`, `docs/product/Modules.md`, `docs/product/Project-specification.md`, `docs/design/design-decisions.md`, `CLAUDE.md`, and current dashboard/widget implementation before coding. Binding product specification is read-only; this document is a proposed redesign plan, not authorization to contradict it. Reuse `packages/design-tokens`, `packages/icons`, and existing dashboard persistence where possible. Avoid breaking existing user layouts; plan migration/versioning if widget geometry or schema changes. Add Playwright interaction tests and visual snapshots, plus RLS/privacy checks where data access is touched.

## Next action
Obtain screenshots or a live interactive review of **normal dashboard**, **edit dashboard**, **widget gallery**, and **widget configuration** at desktop and mobile widths. Refine this plan based on actual visuals and implementation details before starting code.
