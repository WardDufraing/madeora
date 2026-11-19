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

## Approved decision 9 — Smart empty states with user control (2026-11-19)
**Decision: C — Smart empty states with user control.**

- Each eligible widget supports three empty-state presentation preferences: **Full**, **Compact**, or **Hide when empty**. Use sensible widget-specific defaults and make the preference discoverable in widget settings.
- Full shows a purposeful, friendly empty state with a relevant action when permitted. Compact shows a brief summary and optional action within the widget's allocated grid area, without resizing its saved geometry.
- Hide when empty removes the widget from the rendered dashboard temporarily, **not** from the saved widget configuration. It returns automatically when eligible content appears.
- Avoid unexpected layout jumping: retain stable saved positions, and prototype a predictable policy for temporary hidden-widget gaps versus visual compaction before implementation. Never silently mutate the saved layout as data changes.
- In edit mode, always display hidden-when-empty widgets with an explicit hidden-state indicator so they remain configurable and removable.
- Distinguish genuinely empty, loading, failed, offline, filtered-out and permission-restricted states; never mistake an API failure for an empty widget.
- Respect Personal/Home context and permissions for both visibility and action affordances. Keep screen-reader announcements and reduced-motion behavior accessible.

## Approved decision 10 — Context-aware hybrid navigation (2026-11-19)
**Decision: C — Context-aware hybrid navigation.**

- Keep **Dashboard**, **Calendar**, and **Tasks** prominent as core navigation destinations, with clear active states and readable labels.
- Make the active **Personal/Home context** highly visible and easy to switch, without confusing navigation with data-sharing permissions.
- Surface a small set of relevant shortcuts for the active context. Provide an organized, searchable **All Modules** destination for the full module catalog.
- Let users pin/unpin favorite modules to primary navigation, respecting available permissions and module eligibility.
- Adapt navigation on narrow screens without hiding critical context or creating inaccessible icon-only controls.
- Preserve the user's current context when navigating between modules where appropriate, and explain unavailable destinations instead of showing unauthorized data.
- Avoid duplicate or competing navigation controls. Keep context switch, favorites, and All Modules consistent across desktop and mobile.
- The exact placement of pinned items, mobile navigation pattern, and per-context favorite persistence remain to be decided.

## Approved decision 11 — Smart workspace switcher (2026-11-19)
**Decision: C — Smart workspace switcher.**

- Prominently identify the active **Personal** or named **Home** space in the app shell with its name, type and an accessible switcher affordance.
- Provide one-step quick switching between Personal and the most recently used Home, while making every other authorized Home available through the workspace selector.
- The selected Home is user-specific and must not imply shared access to personal-only content. Always enforce context boundaries and permissions during switching, loading, deep linking and cache transitions.
- Give each space a subtle recognizable identity (e.g. icon, label or restrained accent) without replacing the user's chosen overall theme or causing disorienting full-app restyling.
- Preserve relevant module navigation where appropriate when switching contexts; otherwise route to a safe dashboard destination with clear feedback.
- Handle removed memberships, unavailable Homes, loading and errors gracefully; never show stale data from the previous workspace.
- Ensure keyboard, screen reader, touch and narrow-screen support.
- Exact switcher placement, recent-Home persistence and switching transitions remain implementation details.

## Approved decision 12 — Adaptive greeting header (2026-11-19)
**Decision: C — Adaptive greeting header.**

- Use a compact, welcoming dashboard header with a time-appropriate greeting, local date and concise contextual summary of the day.
- Adapt header density to viewport size and scroll position, preserving essential controls and reducing vertical space rather than using a permanently oversized hero.
- Show a small number of useful summary signals (such as upcoming events or actionable tasks) only when supported by available data and active Personal/Home permissions.
- Avoid repeating extensive information already shown in dashboard widgets; hide irrelevant or empty summary signals gracefully.
- Express Madeora's **Playful Precision** visual identity with restrained warmth, subtle color and personality, without excessive animation or motivational filler.
- Respect localization, time zone, accessibility, reduced-motion preferences, loading and error states.
- Keep the workspace switcher and navigation discoverable independently of header collapse.
- Exact summary signals, scroll-collapse threshold and greeting personalization remain to be validated in prototypes.

## Approved decision 13 — Ora widget and global assistant launcher (2026-11-19)
**Decision: C — Optional dashboard widget + global assistant launcher.**

- Provide an optional, configurable **Ora dashboard widget** for permission-aware contextual insights, proactive suggestions and useful reminders.
- Provide a compact **global Ora launcher** across Madeora that opens the full contextual assistant panel without requiring navigation back to the dashboard.
- Both entry points share assistant state and context, respecting the active Personal/Home workspace, assistant permissions, proactive mode and notification preferences.
- Separate responsibilities: widget surfaces insights; launcher opens interaction. Avoid duplicated notifications, competing prompts or inconsistent unread counts.
- Keep the launcher unobtrusive and accessible on mobile, avoid overlapping navigation/content, and allow users to hide it in favor of another discoverable Ora entry point.
- Preserve existing product boundaries: Ora is contextual rather than an unrestricted general AI assistant, and multi-step actions require appropriate confirmation.
- Provide accessible focus handling, keyboard support, reduced-motion behavior and clear loading/error states.
- Launcher positioning, visibility defaults and widget insight density remain to be prototyped.

## Approved decision 14 — Soft Neumorphism with one custom accent (2026-11-19)
**Decision: B — Soft Neumorphism.**

- Establish a restrained, tactile design language: gently elevated widget cards, subtle inset controls where appropriate, rounded corners, soft layered shadows and calm neutral surfaces.
- Preserve the approved **Playful Precision** personality through friendly details, disciplined spacing and legible hierarchy; avoid exaggerated skeuomorphism or low-contrast decoration.
- **Single user-selectable accent color:** honor Madeora's existing custom color picker as the sole user-chosen accent. Derive accessible tonal variations (lighter/darker, translucent tints, hover/pressed/focus states) algorithmically from that selection, rather than assigning fixed colors to modules or widget categories.
- Keep semantic success, warning, error and informational indicators distinct when necessary for meaning and accessibility; these are not additional decorative module accents.
- Use semantic design tokens for surfaces, borders, elevations, shadows and accent roles. Ensure both light and dark themes work with arbitrary supported accent colors, including extreme light/dark selections.
- Do not rely on shadows, hue or subtle inset depth alone to communicate state: provide visible borders, labels, focus rings and adequate text/icon contrast.
- Respect reduced-motion and high-contrast preferences, performance constraints and responsive density. Avoid heavy blur or complex shadows that degrade scrolling on low-powered devices.
- Validate the visual direction in realistic dashboard prototypes with dense widgets, empty states, editor overlays and custom accent selections.
- Exact elevation scale, radius scale, token names and color derivation algorithm remain implementation details.

## Approved decision 15 — Pronounced tactile neumorphic depth (2026-11-19)
**Decision: C — Pronounced tactile depth.**

- Make neumorphic depth a clearly recognizable part of Madeora's interface: visibly raised widget cards, deeper but controlled layered shadows, generous corner radii and prominent inset surfaces for appropriate controls.
- Define distinct elevation roles for dashboard background, raised widget, elevated overlay, pressed/inset control and focused/selected state, using reusable semantic tokens rather than arbitrary per-widget shadows.
- Adapt highlight and shadow strength to light and dark themes; maintain sufficient contrast, legibility and separation even when the user selects a very light or dark custom accent.
- Keep the **single user-selectable accent** with derived tonal variants; do not introduce fixed decorative per-module colors.
- Preserve a clear content hierarchy and usable density even with many widgets. Avoid visual clutter, excessively soft text, expensive blur and excessive stacking of shadows.
- Use explicit borders, labels, focus indicators and state changes where needed: depth alone must never be the only sign of interaction or selection.
- Honor high-contrast and reduced-motion settings, with simplified surface treatment where necessary for accessibility or performance.
- Test realistic dense layouts, mobile screens, the widget gallery, side panels, empty states and dark mode before finalizing elevation values.

## Approved decision 16 — Moderately rounded geometry (2026-11-19)
**Decision: A — Moderately rounded.**

- Use approximately **12–16px** corner radii for standard dashboard widget cards and approximately **6–10px** for buttons, inputs, menus and smaller controls.
- Allow larger overlay panels or special components slightly larger radii when justified by scale, but avoid a pervasive pill-shaped or extra-rounded appearance.
- Pair the moderate radius scale with the approved **pronounced tactile neumorphic depth**: visibly elevated cards and inset controls should feel refined, structured and approachable rather than inflated.
- Define a consistent semantic radius token scale and apply it across widgets, navigation, gallery, editor, dialogs and mobile.
- Keep the existing **single user-selected accent** system with derived tones; geometry does not introduce fixed per-module colors.
- Verify clipping, focus rings, shadow bounds, dense layouts and touch targets across breakpoints. Exact pixel values remain subject to visual and accessibility validation.

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
- **Approved:** Full / Compact / Hide when empty per-widget preferences; preserve saved geometry and never silently remove a configured widget.
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
- Empty widgets: **DECIDED — user-selectable Full / Compact / Hide when empty**; temporary hidden-widget gap policy pending.
- Widget configuration: **DECIDED — hybrid quick settings popover + advanced side panel with preview**; configuration save semantics pending.
- Navigation: **DECIDED — context-aware hybrid navigation** with Dashboard/Calendar/Tasks, pinned favorites and All Modules.
- Workspace switching: **DECIDED — prominent active-space selector, quick Personal/most-recent-Home switching, other Homes in menu**.
- Dashboard header: **DECIDED — compact adaptive greeting with date and permission-aware daily summary**.
- Visual treatment: **DECIDED — Soft Neumorphism with pronounced tactile depth** (raised cards, deeper layered shadows, inset controls), **moderately rounded geometry** (widgets ~12–16px, controls ~6–10px), one user-selected accent and derived tonal variants, no fixed per-module colors.
- Ora: **DECIDED — optional insights widget plus unobtrusive, hideable global assistant launcher**, with shared context and no duplicate alerts.

## Engineering guardrails
Read `docs/product/Project-entry.md`, `docs/product/Modules.md`, `docs/product/Project-specification.md`, `docs/design/design-decisions.md`, `CLAUDE.md`, and current dashboard/widget implementation before coding. Binding product specification is read-only; this document is a proposed redesign plan, not authorization to contradict it. Reuse `packages/design-tokens`, `packages/icons`, and existing dashboard persistence where possible. Avoid breaking existing user layouts; plan migration/versioning if widget geometry or schema changes. Add Playwright interaction tests and visual snapshots, plus RLS/privacy checks where data access is touched.

## Next action
Obtain screenshots or a live interactive review of **normal dashboard**, **edit dashboard**, **widget gallery**, and **widget configuration** at desktop and mobile widths. Refine this plan based on actual visuals and implementation details before starting code.
