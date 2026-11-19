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

## Approved decision 17 — Balanced dashboard spacing (2026-11-19)
**Decision: B — Balanced spacing.**

- Use comfortable, consistent gaps between dashboard widgets and measured internal padding so pronounced neumorphic elevations remain visually distinct without wasting screen space.
- Define semantic spacing tokens for the dashboard grid, widget shells, headers, controls, gallery cards and edit-mode affordances; avoid ad hoc values per widget.
- Keep a useful number of widgets visible on common laptop screens, while retaining adequate text hierarchy, scanability and pointer/touch target sizes.
- Scale spacing responsively: modestly reduce gaps and padding on narrower viewports without sacrificing accessibility or collapsing interactive targets.
- Coordinate grid gaps, widget shadows and moderately rounded card geometry so shadows do not collide or clip.
- Validate dense and sparse layouts, long localized labels, varying widget sizes and light/dark modes before fixing numeric spacing values.

## Approved decision 18 — Adaptive widget content hierarchy (2026-11-19)
**Decision: C — Adaptive widget hierarchy.**

- All widgets use a consistent, accessible header and action pattern (title, optional icon/status, overflow/configuration affordance) while tailoring their main content to the module's purpose.
- Content adapts meaningfully to the widget's **supported snapped grid size**, not merely by scaling text or stretching identical information.
- Small widgets prioritize a useful at-a-glance summary; medium widgets add the most relevant details; larger widgets can expose richer lists, context and direct actions where permissions permit.
- Maintain core information and action priority across sizes; progressively disclose secondary information rather than truncating essential status or leaving dead space.
- Keep widget-specific minimum/maximum dimensions and responsive mobile variants consistent with approved hybrid resizing.
- Provide predictable loading, error, empty and permission-restricted states at each supported size, honoring the approved Full/Compact/Hide-when-empty preference.
- Do not expose private Personal data in Home context or enable actions without appropriate permissions.
- Validate keyboard navigation, touch targets, screen reader reading order, localization and zoom at every supported size.
- Define widget-by-widget content priority and size variants during the component audit, with reusable primitives rather than one rigid universal body template.

## Confirmed usability fixes — Tasks creation and Calendar modal (2026-11-19)

These are user-reported issues/requirements, separate from the still-open dashboard decision 19.

### Tasks: visible primary creation action
- **Observed in the current Tasks page:** there is no visible **Add Task** action in the page content. When no task lists exist, the page directs users to **Lists and Labels** first, and the empty state says to add a task without offering a direct creation control.
- Add a prominent, consistently placed **+ New Task** primary action in the Tasks page header, and an equivalent action in the empty state. Ensure keyboard, mobile and screen-reader accessibility.
- Clicking **New Task** should launch a lightweight task-creation flow rather than requiring navigation to list management.
- If a task list is required and none exists, offer inline list creation or a guided first-task setup in the same flow. Do not silently assume a list or create one without appropriate confirmation.
- Respect Personal/Home context and task-list permissions, and show meaningful feedback on creation success/failure.
- Acceptance: a first-time user with zero task lists can discover **New Task** and complete the necessary setup without manually finding the Lists and Labels page.

### Calendar: create events in a modal
- Replace navigation to a separate event-creation page with an accessible modal dialog launched from the Calendar page's create action and applicable calendar-grid interactions.
- Keep the underlying calendar view, selected date, filters and scroll position intact. Closing or cancelling returns to the same view.
- Prepopulate date/time from the calendar interaction when available; provide appropriate calendar and Personal/Home context selection.
- Support sufficiently complex event fields in a spacious responsive dialog (full-screen dialog on narrow devices if needed), without making ordinary creation require full-page navigation.
- Provide clear Save/Cancel actions, validation, loading/error feedback, keyboard focus trapping and restoration, and unsaved-change protection.
- Keep deep links and any existing standalone creation route functional where needed for backward compatibility, but make the modal the default in-context creation experience.
- Acceptance: a user can create or cancel an event without losing their place in the Calendar page.

## Approved cross-module creation UX — Adaptive creation (2026-11-19)
**Decision: B — Adaptive creation.**

- Use a consistent, context-preserving creation pattern across Madeora modules, including Tasks, Calendar, Shopping, Habits and other applicable modules.
- **Quick additions** open compact accessible modal dialogs for a small number of essential fields; prioritize fast completion and sensible prefilled context.
- **Complex creation** uses a larger responsive dialog or drawer when extra fields, previews, multi-step input or contextual reference material is necessary.
- Reserve **full-page creation** for genuinely complex workflows that require dedicated workspace, without making it the default.
- Preserve underlying route, scroll position, selected filters, dates and Personal/Home context on open, cancel and successful creation; return focus to the trigger.
- Use consistent Save/Cancel placement, validation, error feedback, unsaved-change protection, focus handling, keyboard controls and responsive mobile behavior.
- Respect permissions and accessibility, and preserve deep-linkable routes where appropriate. Avoid nested dialogs where a single expandable surface suffices.
- The Tasks **+ New Task** action and Calendar event creation modal are the first explicitly identified applications of this pattern.
- This cross-module decision does **not** resolve the still-open **dashboard decision 19** about how much interaction happens inside widgets.

## Approved decision 19 — Contextual inline widget interaction (2026-11-19)
**Decision: C — Contextual inline interaction.**

- Enable frequent, low-friction actions directly inside dashboard widgets when their size, module and permissions allow: e.g., complete a task, check off a shopping item, mark a habit done, or add a simple entry.
- Use the approved **adaptive creation** pattern for more complex interactions: compact modal for quick entry, larger dialog or drawer for advanced details, and full module navigation only when a dedicated workspace is genuinely needed.
- Keep a consistent separation between clicking an item to view its details and interacting with a checkbox, quick-action button or overflow menu; prevent accidental navigation or changes.
- Match the approved **adaptive widget hierarchy**: smaller widgets prioritize summaries and only essential controls, while larger sizes reveal additional useful interactions.
- Preserve dashboard position, selected Personal/Home context and widget state when opening or closing a dialog; update widget content promptly after successful actions and show clear errors if they fail.
- Respect role-based permissions, private-versus-shared data boundaries, and confirmations for destructive or sensitive operations; support undo where practical for reversible actions.
- Ensure keyboard and screen-reader accessibility, touch-friendly targets, visible focus, loading/disabled states and no conflicts with drag/resize behavior in Edit Dashboard mode.
- Avoid turning widgets into complete miniature applications; use progressive disclosure and full modules for dense workflows.

## Approved decision 20 — Minimal widget headers with overflow menus (2026-11-19)
**Decision: B — Minimal header with overflow menu.**

- Use a consistent, visually restrained widget header containing the widget title and a discoverable **three-dot overflow menu** for widget-level actions; avoid always-visible rows of header action icons.
- Put widget configuration, opening the full module, refresh (where applicable), and other secondary widget-level actions in the overflow menu, with context- and permission-aware visibility.
- Preserve **decision 19 contextual inline interaction**: everyday actions such as completing tasks, checking off groceries or adding an entry can remain clearly accessible **within widget content**, rather than being forced into the header menu.
- Keep removal and layout changes governed by the approved dedicated **Edit Dashboard** experience, preventing accidental destructive actions during normal use; show relevant edit actions in edit mode as appropriate.
- Ensure the overflow trigger is keyboard and touch accessible, has a descriptive accessible name, clear focus styling, and remains visible on touch devices (not hover-only).
- On small widgets, protect title truncation and menu access; support translated labels and light/dark contrast.
- Use consistent menu ordering and placement across modules while showing only actions that are meaningful for the current widget and user permissions.

## Approved decision 21 — Soft tonal gradient dashboard background (2026-11-19)
**Decision: B — Soft tonal gradient.**

- Use a restrained, low-contrast **neutral tonal gradient** as the dashboard canvas behind the pronounced neumorphic widget surfaces, adding gentle atmosphere without distracting from content.
- Adapt gradient stops and direction for both light and dark themes; preserve coherent highlight and shadow relationships so raised widgets remain distinct and legible.
- Keep the gradient **neutral**, not a second accent system: Madeora retains the **single user-selectable accent color** with derived tonal variants and no fixed per-module accent colors.
- Prefer stable, subtle transitions over animated gradients or decorative shapes; avoid unnecessary rendering costs and visual noise in dense dashboards.
- Provide a solid-color fallback for high-contrast or constrained rendering environments, and maintain sufficient text, control, border and focus-state contrast.
- Validate appearance at common viewport sizes, in sparse/dense layouts, on mobile, and in wall-display mode.

## Approved decision 22 — Equal-quality light and dark themes (2026-11-19)
**Decision: B — Equal-quality light and dark modes.**

- Treat light and dark mode as equally polished, first-class design targets; neither is a simplified or visually inferior adaptation of the other.
- Define theme-specific semantic tokens for canvas gradients, raised surfaces, layered highlights/shadows, inset controls, borders, text, overlays and interactive states rather than simply inverting colors.
- Preserve the approved **pronounced tactile neumorphic depth**, **moderately rounded geometry**, **balanced spacing** and **subtle neutral tonal gradient** in both themes, tuning elevation and contrast independently for each.
- Maintain a **single user-selectable accent color**; derive accessible tonal variants for each theme without fixed per-module accent colors or an unrelated second palette.
- Meet accessibility expectations for text contrast, keyboard focus, form states and discernible component boundaries; never rely on shadows alone to convey state.
- Respect system theme preferences and user overrides as implemented, avoiding flashes of the wrong theme during load and transitions.
- Validate all widgets, modals/drawers, navigation, edit mode, empty/loading/error states, mobile and wall-display layouts in both themes.
- Keep high-contrast and reduced-motion accommodations available where appropriate.

## Approved decision 23 — Subtle, purposeful motion (2026-11-19)
**Decision: B — Subtle, purposeful motion.**

- Use restrained, intentional animations to reinforce Madeora's tactile neumorphic visual language without making the dashboard feel busy or slow.
- Provide gentle hover, focus and press feedback for interactive controls; use smooth but short modal/drawer entrances and exits, meaningful completion-state feedback, and clear widget movement/reflow previews during dashboard editing.
- Prioritize responsiveness: state changes and essential actions must not wait for decorative animations, and motion should communicate cause/effect rather than attract attention for its own sake.
- Define shared motion tokens (duration, easing, displacement and spring behavior where appropriate) and use consistent patterns across modules and widget sizes.
- Avoid continuous ambient animation, unnecessary bounce, large parallax effects, and excessive motion when many widgets update simultaneously.
- Honor OS/browser reduced-motion preferences with minimal or immediate state changes, preserving clarity and functional feedback.
- Ensure motion does not conflict with drag-and-drop, resizing, focus management, keyboard interaction, touch input or responsive performance; validate in light and dark modes.

## Approved decision 24 — Context-aware action feedback (2026-11-19)
**Decision: C — Context-aware feedback.**

- Use **inline, in-context confirmation** for routine, low-risk actions such as completing a task, checking off a shopping item or marking a habit, primarily through changed states, concise labels and restrained motion.
- Use **toasts or contextual banners** for important outcomes, failures, actions whose affected element disappears, and reversible changes; include a clear **Undo** action where supported and appropriate.
- Avoid showing success toasts for every small action; prioritize calm, low-noise interaction while ensuring outcomes remain discoverable.
- Surface validation errors near their relevant inputs, and provide clear retry or recovery paths for failed saves and connectivity problems.
- Do not imply an action succeeded before the server or relevant persistence layer confirms it; handle optimistic updates with visible rollback/recovery if a request fails.
- Keep notification wording, placement, timing and dismissal consistent across dashboard widgets, Tasks, Calendar and other modules.
- Respect accessibility: announce important status changes via appropriate live regions, ensure keyboard-operable actions and avoid relying solely on color or motion.
- Distinguish transient action feedback from persistent notifications/reminders and from Ora suggestions, preventing duplicate messages.

## Approved decision 25 — Smart responsive mobile layout with optional customization (2026-11-19)
**Decision: C — Smart responsive layout with optional mobile customization.**

- Automatically derive a useful mobile-friendly dashboard from the desktop layout, preserving widget membership and sensible reading order without requiring a second setup.
- Adapt the grid to narrower screens and use the approved **adaptive widget content hierarchy** so each widget displays an appropriate compact or mobile-specific content variant instead of shrinking desktop UI.
- Allow users to **optionally customize mobile widget order and supported sizes/arrangement** in the dedicated Edit Dashboard experience without changing the desktop layout.
- Keep desktop and mobile arrangements synchronized at the widget-membership level: adding or removing a widget should be reflected in both, while deliberate mobile ordering remains intact where possible.
- Define predictable fallback/reflow rules for newly added widgets, changed sizes, viewport transitions and invalid saved layouts; avoid duplicate widgets and inaccessible off-screen content.
- Make drag/reorder controls touch- and keyboard-accessible, with explicit edit mode to prevent accidental changes during everyday use.
- Preserve Personal/Home context, permission boundaries, user-selected accent, both themes, and the approved restrained motion and context-aware feedback.
- Ensure the default experience is useful without any mobile-specific customization, and validate common phone widths, zoom, localization and dense widget collections.

## Approved decision 26 — Adaptive mobile bottom navigation and full menu (2026-11-19)
**Decision: C — Adaptive bottom navigation + full menu.**

- Provide a persistent, touch-friendly **mobile bottom navigation bar** with fast access to core destinations and appropriate user-pinned favorite modules, plus a **More/full-menu** entry for all remaining available modules.
- Keep the bottom bar concise, with a bounded number of clearly labeled destinations; prioritize Dashboard, Calendar and Tasks in line with the approved context-aware navigation approach, adapting to workspace and user preferences.
- The full navigation drawer/menu must expose all permitted modules, workspace switching and less-frequent destinations without requiring a return to the dashboard.
- Reflect the active route and current Personal/Home workspace clearly; preserve navigation consistency within each workspace and avoid revealing unavailable or unauthorized destinations.
- Respect mobile safe areas, keyboard and screen-reader navigation, one-handed reach, accessible touch targets, translated labels and compact viewport widths.
- Avoid conflicts with floating Ora controls, bottom sheets, modal dialogs, browser UI and on-screen keyboards; ensure content is not obscured by the persistent bar.
- Maintain the same information architecture as desktop navigation while using a mobile-appropriate presentation; do not create a separate permission or routing model.
- Test long labels, many pinned modules, landscape layouts, deep links and switching between Personal and Home contexts.

## Approved decision 27 — Scroll-aware mobile bottom navigation (2026-11-19)
**Decision: B — Hide on scroll down, show on scroll up.**

- On mobile, smoothly hide the persistent bottom navigation bar during intentional downward scrolling and reveal it when the user scrolls upward, giving longer dashboards and module views more usable space.
- Use direction thresholds, scroll-distance hysteresis and sensible animation timing to avoid flicker from small movements, elastic scrolling or minor layout shifts.
- Keep navigation visible at the top of a page, when focus moves into its controls, during keyboard or assistive-technology navigation, and when relevant navigation menus or overlays are open.
- Avoid hiding while a user interacts with controls near the bottom edge, and ensure it never obscures content, floating Ora controls, bottom sheets or the on-screen keyboard.
- Honor reduced-motion preferences by minimizing or eliminating slide animation; preserve discoverability and accessible touch targets.
- Maintain safe-area padding and correct content inset as the bar appears/disappears, without jarring content jumps.
- Apply the same behavior consistently across mobile dashboard and module pages, with explicit exceptions for full-screen flows where the bar should not be present.

## Approved decision 28 — Mobile workspace switcher in the top bar (2026-11-19)
**Decision: B — Workspace switcher in the top bar.**

- Keep the active **Personal or Home workspace** clearly identified in the mobile top bar, including an accessible switcher affordance.
- Tapping the switcher opens a compact, touch-friendly workspace selector with fast access to Personal, recently used Homes and the remaining available Homes, consistent with the approved smart workspace-switcher pattern.
- Clearly distinguish private Personal context from shared Home context through names and restrained context indicators; do not rely solely on accent colors or icons.
- Preserve navigation continuity when switching contexts where possible, but never retain or expose data from a workspace the user cannot access.
- Respect membership and permissions; show only available Homes and handle removed access or unavailable destinations gracefully.
- Ensure the selector works with the approved mobile bottom navigation, safe areas, keyboard/screen-reader navigation, long localized Home names and small screens.
- Avoid horizontal swipe gestures for workspace switching, which could conflict with calendars and widget interactions.

## Approved decision 29 — Hybrid contextual creation on mobile (2026-11-19)
**Decision: C — Hybrid contextual creation.**

- Keep a prominent, discoverable **Add/New** action within each relevant module and appropriate contextual actions inside interactive dashboard widgets.
- Include a central **+ Create** action in the mobile bottom navigation; activating it opens a compact, accessible quick-create menu with common entry types (such as task, calendar event, shopping item and other permitted options).
- Prioritize creation options relevant to the current Personal/Home workspace and user context, while allowing access to other available module types without unnecessary navigation.
- Use the approved **adaptive creation** behavior: compact modal for simple entries, larger dialog/drawer for more complex forms, and a full page only for genuinely workspace-intensive workflows.
- Preserve the current page, scroll position, filters, date selection and workspace context when creation is opened or cancelled; restore focus to the originating action.
- Do not add a second persistent floating + button that competes with the existing Ora launcher or mobile navigation.
- Coordinate the central Create control with the scroll-aware bottom bar: ensure the action is discoverable, does not disappear during an open creation menu, and remains keyboard/touch accessible.
- Enforce role-based permissions and privacy boundaries; show only actions the user can perform and make the destination workspace clear before saving.
- Ensure consistent labels, validation, feedback, responsive safe-area handling and screen-reader support.

## Approved decision 30 — Hybrid visual and list-based mobile dashboard editing (2026-11-19)
**Decision: C — Hybrid visual and list editing.**

- In dedicated **Edit Dashboard** mode on mobile, offer **visual drag-and-drop** to rearrange widgets directly in the dashboard preview, with touch-friendly drag handles and clear placement previews.
- Also provide an **alternative list-based editing view** with explicit move-up/move-down or reorder controls and supported widget-size selectors for precision and accessibility.
- Both editing methods operate on the **same recoverable mobile layout draft**, keeping changes synchronized and following the previously approved Done-to-commit / Cancel-to-discard workflow.
- Never enable widget dragging or resizing during normal dashboard use; avoid interference with inline widget interactions and page scrolling.
- Respect the approved **smart responsive mobile layout with optional customization**: changing mobile order/size must not unexpectedly alter desktop arrangement, while widget membership stays coherent.
- Support keyboard and screen-reader operation, accessible touch targets, clear selection/focus states, undo where practical, and reliable reflow previews.
- Preserve user permissions, workspace context, widget-specific size limits and responsive behavior; test narrow screens and long localized labels.

## Approved decision 31 — Saved dashboard layout presets (2026-11-19)
**Decision: B — Saved layout presets.**

- Maintain **one active dashboard per Personal or Home workspace**, rather than adding multiple simultaneously switchable dashboards to the primary navigation.
- Let authorized users **save, name, duplicate and restore dashboard layout presets**, enabling safe experimentation and recovery of preferred arrangements.
- A preset captures widget membership, widget settings relevant to layout, desktop positions and sizes, and the corresponding responsive/mobile arrangement including any explicit mobile overrides.
- Restoring a preset updates the active layout through the established dashboard editing workflow, with a preview and clear confirmation; preserve the previous active layout as a recoverable state where feasible.
- Keep presets scoped to their workspace and enforce applicable Home permissions; never copy private Personal content or data access into a shared Home through a layout preset.
- Provide a sensible default preset/reset path and handle missing, disabled or permission-restricted widgets gracefully when applying an older preset.
- Support clear names, duplicate-name handling, and accessible preset management without introducing a new top-level dashboard-switching navigation concept.
- Multiple concurrently switchable dashboards remain a possible later enhancement, not part of this redesign decision.

## Approved decision 32 — Limited automatic dashboard layout history (2026-11-19)
**Decision: B — Limited automatic version history.**

- Automatically retain the **10 most recent committed dashboard layout configurations per workspace**, separate from explicitly named, saved layout presets.
- Record a version on meaningful saved layout changes (including applying a preset), not on every drag movement, autosaved draft update or transient editing action.
- Allow authorized users to browse versions with a clear timestamp and contextual summary, **preview** the desktop/mobile arrangement, and **restore** a chosen configuration after confirmation.
- Restoring an earlier version creates a new committed version so the layout that was replaced remains recoverable within the rolling history limit.
- Keep saved presets independent of automatic history rotation; never silently delete a named preset when an old automatic version is removed.
- Maintain the existing recoverable edit draft, Done/Cancel semantics, workspace scoping and Home permissions; protect private Personal widget content when reviewing shared Home layouts.
- Handle obsolete, missing or newly restricted widgets safely in previews and restores, with clear messaging rather than exposing inaccessible data.
- Keep the history interface lightweight and accessible; full unlimited version history is out of scope.

## Approved decision 33 — Shared Home dashboard default with personal overrides (2026-11-19)
**Decision: C — Shared default with personal overrides.**

- Each Home has an authoritative **shared default dashboard layout**, editable only by members granted the relevant Home dashboard-management permission.
- Each Home member can optionally create a **personal view override** for that Home, including their own widget arrangement and supported presentation preferences, without modifying the shared default or other members' views.
- New members and members without an override see the shared default, filtered to widgets and data they are permitted to access.
- Clearly label whether the user is editing **My Home view** or the **Shared Home default**; require appropriate permissions for the latter and avoid accidental shared edits.
- Provide an explicit way to return to the shared default or reset personal overrides, with preview and confirmation where changes would be lost.
- Personal overrides must not grant access to otherwise restricted widgets, underlying data or actions; enforce Home membership and item-level permissions at all times.
- Preserve responsive desktop/mobile layout behavior, the approved edit-draft workflow, saved presets and limited version history with appropriate scope and ownership for shared defaults versus personal overrides.
- When the shared default changes, members without overrides receive the new layout; existing personal overrides remain intact where possible, with safe handling of removed or unavailable widgets.
- The shared default also provides a predictable foundation for household displays, subject to the separate wall-display mode and its privacy controls.

## Approved decision 34 — Smart shared Home dashboard updates with member approval (2026-11-19)
**Decision: C — Smart updates with member approval.**

- When authorized Home members update the shared default dashboard, members **without personal overrides** continue to receive the updated shared default automatically.
- Members **with personal dashboard overrides** keep their existing widget order, sizes and layout rather than having shared-default changes silently merged into their custom arrangements.
- When the shared default introduces new widgets, show affected members a subtle, dismissible suggestion identifying the additions, with a preview and explicit **Add to my dashboard** action.
- Let members accept suggested widgets selectively and place them through the approved smart-reflow/editing workflow without unexpected rearrangement; preserve a recoverable edit draft and allow cancellation.
- Avoid repeated or intrusive prompts for dismissed suggestions; make pending shared additions discoverable from dashboard customization.
- Changes to shared-default widget placement or sizing do not automatically override a personalized layout; provide a voluntary review/reset path for members who want to adopt the latest shared default.
- **Permission, membership and data-access changes take effect immediately**, irrespective of approval or dismissal; inaccessible widgets must be hidden or safely disabled without leaking private data.
- Scope suggestions to the current Home and the member's permissions, with appropriate behavior for removed widgets, obsolete suggestions, multiple updates and mobile/desktop layouts.
- Keep notifications lightweight and accessible, consistent with the approved context-aware feedback design.

## Approved decision 35 — Dedicated Home wall-display dashboard layout (2026-11-19)
**Decision: B — Dedicated wall-display layout.**

- Each Home has **one dedicated wall-display dashboard layout**, separate from its shared default Home dashboard and members' personal Home-view overrides.
- Optimize the wall layout for mounted touchscreens and at-a-distance viewing: larger typography and touch targets, simplified controls, legible contrast, clear information hierarchy and responsive landscape/portrait support.
- Let authorized Home members configure wall-display widget selection, arrangement and supported settings without modifying regular Home or Personal layouts.
- Provide a useful initial wall-display template drawn from permitted household information, with an accessible customization and preview workflow consistent with approved dashboard editing principles.
- Respect wall-display privacy boundaries: do not expose sensitive Personal or restricted Home information; require the established PIN or appropriate authentication before opening protected areas or actions.
- Coordinate with display-specific navigation, idle behavior, safe areas and touch ergonomics; avoid tiny desktop-style controls and intrusive transient overlays.
- Keep wall-display configuration scoped to its Home and handle membership, permission and widget-availability changes safely.
- Multiple independently named wall-display profiles per Home are not included in this initial redesign; they may be considered later.

## Approved decision 36 — Automatic ambient mode for wall displays (2026-11-19)
**Decision: B — Automatic ambient mode.**

- After a configurable period without touch interaction, transition the Home wall display from its dedicated dashboard into a simplified **ambient view**.
- Show the **time, date, weather and selected privacy-safe household information** in an at-a-glance presentation, with large legible typography and minimal clutter.
- Restore the dashboard on a deliberate screen tap, without requiring navigation through menus; continue to enforce PIN/authentication for protected areas and actions.
- Never reveal sensitive Personal information or restricted Home content in ambient mode; provide safe defaults and only include household details approved for ambient visibility.
- Use restrained, low-motion transitions and subtle visual variation/position changes where appropriate to mitigate static-image persistence; respect reduced-motion preferences.
- Keep ambient-mode timing configurable for the Home, with sensible defaults and consistent handling of touch activity, overlays, active interactions and screen wake.
- Avoid claiming control over device-level brightness, sleep or hardware burn-in prevention where the browser or operating system does not expose those capabilities.
- Keep the behavior scoped to the wall-display experience; regular mobile and desktop dashboards are unaffected.

## Approved decision 37 — Temporary PIN unlock session on wall displays (2026-11-19)
**Decision: B — Temporary unlock session.**

- Protected wall-display actions require the established wall-display PIN; a successful PIN entry opens a **short-lived five-minute unlock session** rather than prompting for every action.
- Relock automatically when the unlock window expires, the display enters ambient mode, the wall-display session ends, or access is revoked; never keep sensitive information visible after relocking.
- The unlock grants access only to actions already permitted for the authenticated wall-display context and relevant Home; **PIN entry must not bypass membership, roles, or item-level authorization**.
- Keep routine privacy-safe household interactions available without a PIN where permitted; gate protected settings, restricted data and sensitive operations appropriately.
- Particularly destructive or consequential actions still require explicit confirmation and may require fresh authentication if risk warrants it.
- Provide a clear, unobtrusive unlocked-state indicator and an immediately accessible **Lock now** control; avoid displaying the PIN or sensitive details in notifications or ambient mode.
- Implement server-side authorization and expiration checks, rate-limit PIN attempts and handle failed/expired sessions safely; never rely solely on hiding UI controls.
- Support touch accessibility, reduced motion, and appropriate focus handling when locking or unlocking.

## Approved decision 38 — Dashboard-first wall-display navigation with expandable menu (2026-11-19)
**Decision: C — Dashboard-first with expandable navigation.**

- Open the dedicated Home wall-display experience on its dashboard, keeping household information and interactive widgets as the primary surface.
- Provide a compact, clearly identifiable and **always-accessible navigation control** that opens a spacious, touch-friendly menu with the available Home modules and relevant destinations.
- Use large touch targets, readable labels, clear active-state indicators, and accessible focus/keyboard/screen-reader behavior suitable for wall-mounted tablets.
- Let users open a permitted module directly from the menu, then return easily to the dashboard with an obvious Home/Dashboard action.
- Respect Home permissions, wall-display privacy restrictions and the approved temporary PIN unlock flow for protected destinations or actions; never expose restricted content in menu previews.
- Coordinate expanded navigation with ambient mode, overlays, display orientation, safe areas and the wall-display's dedicated layout; close the menu appropriately when entering ambient mode or locking.
- Avoid a permanently expanded sidebar that consumes dashboard space, and do not require a module to have a widget before it can be reached.
- Keep this navigation independent of the mobile phone's scroll-aware bottom navigation while sharing consistent module naming and information architecture.

## Approved decision 39 — Home-bound wall displays with protected reassignment (2026-11-19)
**Decision: C — Home-bound with protected reassignment.**

- Assign each wall-display device to **one specific Home** during setup; normal wall-display navigation, dashboard widgets and ambient mode remain scoped to that Home.
- Do not expose the Personal/Home workspace switcher or a list of other Homes in the wall-display's everyday interface.
- Allow an **authorized administrator** to reassign the device to a different eligible Home through an explicit protected settings flow, with fresh authorization and clear confirmation of the source and destination Home.
- Reassignment must revoke or invalidate the previous Home's wall-display session and unlock state, and securely clear device-local cached data, offline content and any previous Home-specific credentials before activating the new Home.
- Reinitialize the wall display with the destination Home's dedicated wall layout, privacy settings and permitted widgets; do not carry private data or device-specific permissions across Homes.
- Handle interrupted reassignment, revoked Home membership, lost authorization and network failures safely, leaving the display locked or in setup rather than showing stale household data.
- Keep server-side authorization and device-to-Home binding authoritative; a wall-display PIN alone must not authorize cross-Home reassignment.
- Provide an auditable indication of reassignment to authorized Home administrators where activity logging is available.

## Approved decision 40 — Editorial desktop dashboard hero header (2026-11-19)
**Decision: C — Editorial hero header.**

- Use a distinctive **editorial-style hero header** on desktop dashboards: expressive, prominent typography; a warm, context-aware greeting or headline; and a concise supporting line such as the current date or daily context.
- Include one carefully selected, permission-aware **contextual highlight** (for example, the next upcoming event), rather than a dense row of competing statistics or controls.
- Preserve the previously approved **collapsible greeting/header** behavior, with a compact state that prioritizes dashboard widgets and avoids excessive vertical space.
- Maintain Madeora's **Playful Precision** visual language, soft tonal gradient background, pronounced tactile depth, moderately rounded geometry, restrained animations and user-selected accent.
- Ensure long localized text, small desktop widths, reduced motion, light/dark themes and empty or unavailable contextual data all have polished fallbacks.
- Avoid exposing private Personal information in a shared Home header; scope greetings and contextual highlights to the active workspace and permissions.
- Treat this as a visual presentation choice for the desktop dashboard, not a change to navigation, permissions, or underlying module functionality.

## Approved decision 41 — Hybrid floating desktop sidebar navigation (2026-11-19)
**Decision: C — Hybrid floating navigation.**

- Style the desktop sidebar as a **softly elevated, rounded, floating-feeling navigation surface**, visually distinct from the dashboard content while remaining part of the stable application shell.
- Include Madeora branding, a prominent and clearly labeled **Personal/Home workspace selector**, and a concise hierarchy of primary destinations, favorites/contextual shortcuts and All Modules.
- Use rounded, tactile active-route treatments, readable icon-and-text labels, restrained accent usage and subtle hover/focus feedback; preserve the approved one-user-accent color system.
- Support an accessible **collapsed navigation state** that frees horizontal space while preserving recognizable destinations, tooltips/labels, keyboard access and an obvious expand control.
- Keep lower-frequency actions such as Settings available without crowding the main navigation, and preserve clear separation between workspace context and route selection.
- Apply the approved Playful Precision, pronounced tactile depth, moderate rounding, balanced spacing, soft neutral background, light/dark parity and purposeful motion.
- Ensure the sidebar adapts gracefully to narrower desktop/tablet widths and long localized labels, without obscuring content or duplicating the mobile bottom-navigation system.
- Honor permissions and active workspace context; never expose restricted modules or private Home/Personal information through sidebar previews.

## Approved decision 42 — Adaptive spacious main content canvas (2026-11-19)
**Decision: C — Adaptive spacious canvas.**

- Make the desktop dashboard content canvas expand responsively with available viewport width, rather than forcing a narrow fixed maximum width or stretching widgets edge-to-edge.
- Maintain generous, responsive outer margins and balanced gutters between the floating sidebar, editorial hero header and widget grid.
- Apply sensible minimum/maximum widget widths and responsive grid columns so ultrawide displays remain readable and smaller laptop screens remain useful.
- Preserve the approved smart widget reflow, snapping, layout presets and desktop/mobile-specific layout behavior.
- Maintain the Playful Precision design language, tactile surfaces, neutral gradient backdrop and consistent spacing across module pages as appropriate.
- Prevent horizontal overflow, awkward empty columns and unreadably wide text; respect browser zoom and localization.

## Additional calendar UX requirement — Visible work schedule (2026-11-19)

- Provide a clear, discoverable way for users to **add their work schedule to Madeora's calendar** and see scheduled working periods alongside other calendar events.
- Support recurring work patterns, varying shifts/start and end times, and exceptions such as days off or changes to a specific shift.
- Make work periods visually distinguishable from ordinary events without requiring a fixed module color, consistent with Madeora's user-selected accent and accessible calendar styling.
- Let users choose the appropriate Personal or permitted Home visibility/calendar destination, respecting existing calendar-sharing and privacy rules.
- Provide an intuitive entry/edit flow compatible with the approved adaptive calendar creation dialogs, and handle time zones and recurrence reliably.
- Include work-schedule visibility in relevant calendar views and filters; do not silently replace or duplicate events imported from connected calendars.
- Treat detailed scheduling workflow, templates and synchronization specifics as follow-up UX/product decisions rather than assuming them here.

## Approved decision 43 — Work schedules as subtle calendar background blocks (2026-11-19)
**Decision: B — Subtle background time blocks.**

- Display scheduled working periods as **lightly tinted, low-emphasis background time blocks** in the calendar, visually distinct from ordinary foreground events.
- In day and week time-grid views, position work blocks behind regular appointments and meetings so events remain legible and interactive.
- Label work periods with an accessible **Work** indicator and their start/end times; use patterns, icons or text in addition to tonal differences rather than relying on color alone.
- Support overlapping foreground events without obscuring event text or hit targets; provide a deliberate interaction target to inspect or edit a work shift.
- Adapt the presentation for compact month and mobile views with a concise indicator or summary rather than forcing a dense background time grid.
- Respect the approved user-selectable accent system, light/dark parity, contrast requirements and reduced-motion preferences; avoid introducing a fixed work-module color.
- Keep work schedules filterable and compatible with recurring shifts, exceptions, privacy/visibility rules and calendar synchronization safeguards described in the work-schedule UX requirement.
- Ensure printed or exported calendar views remain understandable without depending on subtle background colors.

## Approved decision 44 — Minimal borderless calendar visual design (2026-11-19)
**Decision: C — Minimal borderless calendar.**

- Present Madeora's calendar as an **airy, minimal, largely borderless interface** rather than a traditional heavy grid or individually raised day-cell cards.
- Use whitespace, alignment, restrained dividers where needed, and clear typography to communicate day/week/month structure; keep event scanning effortless.
- Distinguish **today, selected dates, weekends and days with events** through accessible text emphasis, subtle tonal highlighting and concise event indicators rather than thick outlines.
- Keep event chips/blocks readable and interactive when many events are present, with sensible overflow indicators and drill-down affordances for dense days.
- Apply the approved **subtle background time-block treatment for work schedules** in day/week views, with compact representations in month/mobile views.
- Preserve keyboard navigation, visible focus states, adequate touch targets, contrast, localization, light/dark theme parity and accessible non-color-only status cues.
- Retain the app-wide Playful Precision aesthetic and user-selectable accent, but intentionally use **less card depth and fewer visible borders within the calendar grid** than in surrounding dashboard surfaces.
- Ensure event creation continues to open in an adaptive modal/drawer rather than unexpectedly navigating away from the calendar.

## Approved decision 45 — Adaptive calendar event preview (2026-11-19)
**Decision: C — Adaptive event preview.**

- Selecting an existing calendar event opens a **compact, contextual preview** showing its title, date/time, relevant location or calendar context, and primary actions such as Edit and More details.
- On desktop, anchor the preview near the selected event where space permits; reposition or use an appropriate dialog/panel on narrow viewports to prevent clipping.
- On mobile, present the quick preview as a **touch-friendly bottom sheet** with clear dismissal, drag/scroll handling and accessible controls.
- Provide a **More details** action that expands into a richer panel or dialog for descriptions, recurrence, attendees, connected-calendar metadata and other advanced information without navigating away unnecessarily.
- Keep the underlying calendar visible and preserve the current date, view, scroll position and filters on opening and closing the preview.
- Respect event visibility, workspace privacy, ownership and permissions; show only permitted fields and actions, with appropriate handling of read-only synced events.
- Support keyboard and screen-reader focus management, escape/dismiss behavior, long localized content and event overlap; avoid hiding other event controls behind the preview.
- Keep styling consistent with the minimal borderless calendar and the approved adaptive creation/edit dialogs.

## Approved decision 46 — Hybrid Tasks productivity workspace (2026-11-19)
**Decision: C — Hybrid productivity workspace.**

- Structure the Tasks page as a clean unified workspace with easily discoverable **Today, Upcoming, All Tasks and Lists** views, using a lightweight view switcher that adapts to desktop and mobile.
- Make **Today** the intuitive daily starting point, emphasizing immediate priorities without hiding future or list-organized work.
- Keep a prominent, clearly labeled **+ New Task** action in the page header across all views, including empty states and before any lists have been created.
- Allow users to create their first task without requiring a pre-existing list; provide a welcoming first-task/first-list path and sensible destination defaults.
- Keep task rows scannable, with accessible completion controls, useful due-date/priority context and uncluttered inline quick actions; use deeper dialogs/drawers only when appropriate.
- Preserve workspace and permission context, search/filter capabilities and clear distinctions between Personal and Home tasks.
- Maintain the approved Playful Precision aesthetic, responsive spacing, subtle depth and user-selected accent while avoiding excessive card nesting or visual clutter.
- Make navigation among views and task creation responsive and keyboard/touch accessible, preserving current view and filters after task editing.

## Approved decision 47 — Adaptive individual task rows (2026-11-19)
**Decision: C — Adaptive task rows.**

- Render individual tasks as **compact, lightly separated rows** within clearly labeled groups, rather than permanently elevated standalone cards or completely unstructured text.
- Show the completion control and task title consistently; reveal supplementary information such as due date, priority, list or workspace only when relevant and useful for scanning.
- Use subtle hover, focus, selected and active states to distinguish interactive rows, with touch-accessible actions and an overflow menu for less frequent operations.
- Let section headings such as Today and Upcoming organize task density; use subtle surface treatments or grouping instead of deep nested cards.
- Provide contextual **Add a task** affordances inside task groups while retaining the prominent global **+ New Task** action in the Tasks page header.
- Maintain clear completed-task styling, sufficient contrast, keyboard and screen-reader accessibility, and sensible text wrapping for long or localized titles.
- Respect the approved adaptive creation/edit dialogs, task permissions, Personal/Home context and responsive mobile layout.
- Match the app's Playful Precision visual system while keeping long task lists compact and efficient.

## Approved decision 48 — Adaptive task details and editing (2026-11-19)
**Decision: C — Adaptive task detail experience.**

- Selecting a task opens a **lightweight detail experience** that progressively reveals more information and editing controls as needed, instead of always opening a large modal or navigating to a separate page.
- On desktop, use a responsive **task details side panel** that keeps the underlying task list visible and lets users switch between tasks efficiently.
- On mobile, start with a touch-friendly **bottom sheet** for quick viewing and simple edits, expanding to a larger sheet or full-screen editor for complex tasks, lengthy descriptions, subtasks and attachments.
- Show the task title, completion state and most relevant metadata immediately; progressively disclose descriptions, subtasks, attachments, recurrence and other advanced fields.
- Keep quick changes such as completion, title, due date and priority efficient, while ensuring destructive actions have appropriate confirmation or recovery.
- Preserve the active Tasks view, search/filter state, scroll position and selected workspace when opening, switching or dismissing task details.
- Respect task ownership, Personal/Home privacy and edit permissions, with accessible read-only states where appropriate.
- Provide keyboard focus management, Escape/close behavior, screen-reader labeling, comfortable touch targets and responsive handling for long localized text.
- Maintain the approved adaptive task-row styling and app-wide Playful Precision visual language without excessive nested cards.

## Approved decision 49 — Progress-focused subtask checklist (2026-11-19)
**Decision: B — Progress-focused checklist.**

- Show subtasks inside the adaptive task detail view as a **compact, clearly labeled checklist** rather than separate elevated cards.
- Include a **subtle progress bar** and explicit completion count (for example, “2 of 5 completed”) so progress is understandable without relying on color alone.
- Update the progress indicator immediately when a subtask is checked or unchecked, with restrained, purposeful feedback and no distracting animation.
- Distinguish completed subtasks using accessible checkbox states and restrained typography, preserving legibility and the ability to review or reopen completed items.
- Provide a discoverable **Add subtask** affordance at the end of the list and maintain efficient keyboard and touch interactions.
- Keep the section compact and readable for tasks with many subtasks, with appropriate wrapping and responsive behavior in desktop side panels and mobile sheets.
- Respect task permissions, workspace context, light/dark theme contrast and reduced-motion preferences.
- Match the approved adaptive task-row styling and Playful Precision aesthetic without unnecessary nested card depth.

## Approved decision 50 — Subtle satisfying task completion feedback (2026-11-19)
**Decision: B — Subtle satisfying animation.**

- Completing a task immediately updates its checkbox and completed state, accompanied by a **brief, restrained checkbox transition and gentle highlight**.
- Show a short, unobtrusive completion acknowledgment where appropriate; avoid persistent celebratory banners, confetti or excessive movement for routine completions.
- Keep task completion responsive and allow users to undo or reopen a task without losing their place in the current Tasks view.
- Use accessible non-color-only completed styling, maintain readable task titles and avoid layout shifts that make subsequent tasks difficult to select.
- For repeated or bulk completions, reduce redundant visual effects and avoid stacking feedback.
- Honor reduced-motion settings by using instant state changes or non-animated emphasis while retaining clear confirmation.
- Apply the same restrained interaction language to subtasks, keeping their progress count and progress bar synchronized.
- Match Madeora's Playful Precision design language and the previously approved subtle, purposeful motion and contextual feedback patterns.

## Approved decision 51 — Adaptive completed-task display (2026-11-19)
**Decision: C — Adaptive completion behavior.**

- After task completion, **briefly retain the completed row in place** so the approved subtle completion feedback remains perceptible and users can easily undo the action.
- Then move the completed task to a **collapsed Completed section** within the relevant task view or group, keeping active tasks visually prominent without losing access to finished work.
- Display a concise Completed label and count, with a clear expand/collapse affordance; expanded completed tasks remain readable, with muted styling and accessible completion indicators.
- Allow users to **undo or reopen** completed tasks and return them to the appropriate active grouping without losing task details or workspace context.
- Offer a discoverable display preference for completed tasks, such as keeping them visible or automatically grouping them, without adding persistent clutter to the primary Tasks page.
- Avoid unexpected row movement during rapid or bulk completions, keyboard interaction, drag operations or while a task detail panel is open; preserve focus and scroll position.
- Ensure behavior remains understandable with reduced motion, screen readers and keyboard navigation, and consistent across Today, Upcoming, All Tasks and Lists.
- Maintain the approved adaptive task-row appearance, contextual feedback and permission-aware Personal/Home task handling.

## Approved decision 52 — Colored task priority indicators (2026-11-19)
**Decision: A — Colored priority indicators.**

- Display a **slim, unobtrusive color-coded priority bar** alongside task rows so high-, medium- and low-priority items can be distinguished quickly without turning each row into a large card.
- Establish a consistent semantic priority palette (for example, urgent/high in a warm red family, medium in amber and low in a muted green/neutral family), with accessible contrast in both light and dark themes.
- Treat these colors as a **narrow semantic exception** to Madeora's single user-selected accent rule: the accent continues to drive general interface styling, while priority hues communicate task importance only.
- Never rely on color alone: provide accessible priority names, tooltips or icons where needed, including screen-reader labels and clear detail-view descriptions.
- Keep normal/unprioritized tasks visually quiet, without unnecessary bars or badges; ensure color indicators do not compete with due dates, completion controls or workspace labels.
- Use consistent meanings across Today, Upcoming, All Tasks, Lists and task details, and maintain a sensible monochrome/print fallback.
- Preserve the approved adaptive task-row density, completed-task styling and responsive keyboard/touch interactions.

## Approved decision 53 — Adaptive overdue task emphasis (2026-11-19)
**Decision: C — Adaptive overdue emphasis.**

- Show overdue tasks with a **clearly visible overdue due-date label** and restrained typographic emphasis rather than applying a strong red background to every overdue row.
- Include a concise, accessible relative indicator such as “Overdue · 3 days” together with the underlying due date where useful; avoid relying on color alone.
- Reserve stronger visual treatment (for example, a subtle warm tint or additional warning icon) for significantly overdue or genuinely time-critical tasks, without implying that lateness automatically changes the task's user-assigned priority.
- Keep the **semantic color-coded priority bar** approved in Decision 52 independent from overdue status, so urgency and priority remain distinct signals.
- Keep due-today and upcoming labels readable and quieter than overdue labels, with consistent presentation across Today, Upcoming, All Tasks, Lists and task details.
- Avoid overwhelming the interface when many tasks are overdue; retain the compact adaptive row layout, predictable alignment and clear completion controls.
- Ensure accessible contrast, non-color-only labels, localization of dates, correct timezone handling and parity across light/dark themes and mobile layouts.

## Approved decision 54 — Adaptive task list navigation (2026-11-19)
**Decision: C — Adaptive list navigation.**

- In the Tasks workspace's **Lists** view, display a small number of frequently used lists as compact, clearly labeled **tabs or chips**, enabling quick switching without a second permanent sidebar.
- When the list count grows or the available width shrinks, transition to an accessible **searchable list selector** instead of wrapping into cluttered rows.
- On mobile, use a compact, touch-friendly list picker that preserves room for task content and the prominent **+ New Task** action.
- Provide a discoverable **+ New List** affordance in both tab/chip and selector presentations, including empty states.
- Keep the selected list visually obvious through typography, shape and restrained accent emphasis; do not rely on color alone.
- Preserve list context, search/filter state and scroll position when users inspect tasks or return from task details.
- Handle long localized list names, large numbers of lists, keyboard navigation and screen-reader semantics gracefully.
- Respect Personal/Home workspace boundaries and list visibility permissions; retain the approved Today, Upcoming, All Tasks and Lists top-level views.
- Follow the Playful Precision visual language and compact adaptive task-row design without introducing an additional persistent navigation column.

## Approved decision 55 — Hybrid quick-add task creation (2026-11-19)
**Decision: C — Hybrid quick-add experience.**

- Provide a discoverable **inline Add a task field** in task groups that expands into a compact editor when activated, enabling rapid entry without leaving the current list or view.
- In the expanded quick-add state, offer lightweight controls for **due date, priority and destination list**, with an obvious **More options** action to open the full adaptive task editor for descriptions, subtasks, recurrence, attachments and advanced settings.
- Make the persistent page-header **+ New Task** button open the same compact, context-aware creation experience, using a suitable dialog or sheet when an inline insertion point is not available.
- Support creating the very first task **without requiring a pre-existing list**, with sensible Personal/Home defaults and an optional first-list flow.
- Preserve the current Tasks view, selected list, search/filter state and scroll position after creating a task; offer clear success feedback and a convenient way to add another.
- Ensure keyboard-first submission, accessible labels and focus management, touch-friendly controls, validation and unsaved-input safeguards.
- Respect workspace context and permissions; never silently assign tasks to an inaccessible list or expose private task data.
- Match the approved adaptive task rows, minimal visual clutter and adaptive task detail/editing experience.

## Approved decision 56 — Adaptive Notes workspace (2026-11-19)
**Decision: C — Adaptive notes workspace.**

- Structure the Notes page as a flexible workspace with **grid and list presentation modes**, letting users browse visually rich note previews or compact, efficient rows.
- Provide discoverable **search, Favorites and Folders** navigation alongside All Notes, adapting the controls to available screen width without crowding the page.
- In grid mode, show legible note titles, restrained excerpts and useful context such as modified date; keep card heights and content truncation balanced for scannability.
- In list mode, prioritize titles, concise metadata and fast scanning, with subtle row separation and contextual actions rather than excessive card depth.
- Make the active view and filter obvious, preserve user view preference and maintain context when opening or returning from a note.
- Keep a prominent **+ New Note** action visible, including helpful empty states for first notes, empty folders and search results.
- Respect Personal/Home workspace boundaries, permissions and privacy when displaying note previews or folder contents.
- Ensure responsive mobile behavior, keyboard navigation, accessible labels, long localized titles and consistent light/dark contrast.
- Apply Madeora's Playful Precision, moderate rounding, balanced spacing and user-selected accent without sacrificing readability.

## Approved decision 57 — Adaptive focused note editor (2026-11-19)
**Decision: C — Adaptive focused note editor.**

- Open notes in a **clean, focused reading and editing experience** with prominent note title, uncluttered content area, concise metadata and contextual navigation back to the Notes workspace.
- On wider desktop layouts, allow the notes list or browsing context to remain visible beside the editor when space permits, supporting quick switching between notes.
- On smaller screens, prioritize a comfortable single-column writing surface with a clear, accessible return path to the previous collection, folder, filter or search.
- Offer an optional **distraction-free focus mode** that temporarily reduces surrounding navigation and secondary controls while keeping essential save/status and exit actions accessible.
- Place frequent actions such as favorite, formatting and relevant sharing controls within easy reach, with lower-frequency operations in a restrained overflow menu.
- Preserve the selected note, browsing context, scroll position and unsaved edits when switching between responsive layouts or entering/exiting focus mode.
- Use readable typography, sensible line length, clear paragraph spacing and keyboard/touch-friendly editing controls, including accessible focus states and long-content handling.
- Respect Personal/Home visibility and editing permissions, with clear read-only presentation when appropriate.
- Follow the approved adaptive Notes grid/list workspace and Madeora's Playful Precision visual style without excessive editor chrome.

## Approved decision 58 — Hybrid contextual note formatting (2026-11-19)
**Decision: C — Hybrid contextual formatting.**

- Keep a **compact, always-available formatting toolbar** for common block-level actions such as headings, bulleted/numbered lists and inserting supported content, with an overflow menu for less-frequent commands.
- Show a **contextual text-formatting toolbar** when text is selected, offering appropriate inline actions such as bold, italic, underline and links without permanently occupying the writing surface.
- Ensure toolbar positioning never obscures selected text, active input or the on-screen keyboard; adapt to a touch-friendly selection menu or bottom toolbar on mobile.
- In the approved **distraction-free focus mode**, minimize persistent chrome while keeping formatting accessible through selection, keyboard shortcuts and a clear reveal action.
- Use predictable active states, accessible names and tooltips, keyboard navigation, visible focus indicators and non-color-only feedback.
- Preserve selection, cursor position, undo/redo behavior and unsaved edits when invoking formatting controls.
- Support localization, responsive layouts and Madeora's Playful Precision visual language with restrained shadows, rounding and user-accent highlights.
- Treat this as a visual/interaction design decision; the exact supported rich-text feature set and storage format remain separate implementation concerns.

## Approved decision 59 — Adaptive Notes folder navigation (2026-11-19)
**Decision: C — Adaptive folder navigation.**

- Show a manageable number of **frequently used folders as compact tabs or chips** in the Notes workspace for immediate, low-friction navigation.
- When the number of folders exceeds available space, replace or supplement the chips with an accessible **searchable folder picker** rather than introducing cluttered multi-row navigation.
- On mobile, default to a **compact, touch-friendly folder picker** that leaves ample room for note previews and the prominent **+ New Note** action.
- Keep **All Notes** and **Favorites** discoverable alongside folder navigation, with clear selection states and predictable behavior when switching folders.
- Provide a visible **+ New Folder** affordance in both compact and expanded navigation states, including empty collections.
- Use restrained user-accent emphasis, typography and shape to indicate the active folder; do not rely on color alone.
- Handle long localized folder names, keyboard and screen-reader navigation, large folder collections and responsive resizing gracefully.
- Preserve search/filter context, selected folder and scroll position when opening notes or returning from the adaptive focused editor.
- Respect Personal/Home workspace boundaries and note/folder permissions; avoid exposing inaccessible folders or note previews.
- Align with Decision 56's grid/list Notes workspace and Decision 57's focused editor without adding a second permanent sidebar.

## Approved decision 60 — Adaptive content-aware note preview cards (2026-11-19)
**Decision: C — Adaptive content-aware cards.**

- In the Notes workspace grid, show **compact, text-first previews** for ordinary text notes, emphasizing a clear title, concise excerpt and restrained relevant metadata.
- For notes containing supported images or structured content, offer **richer content-aware previews** (such as a modest image thumbnail or recognizable structured excerpt) without forcing every note into a large media card.
- Maintain a **balanced, orderly grid** using controlled card heights, consistent padding, image aspect ratios and sensible text truncation; avoid uncontrolled masonry-like variation that hurts scanning.
- Make pinned/favorited states recognizable through small accessible icons or labels rather than large decorative treatments; keep card actions contextual and unobtrusive.
- Ensure preview content is permission-aware, excludes sensitive/private information from unauthorized contexts, and falls back gracefully when images are missing or unavailable.
- In the approved list view, use compact title-and-metadata rows rather than forcing rich card layouts into narrow space.
- Preserve strong text contrast, keyboard/touch access, accessible image alternatives and readable results in light/dark modes and across responsive widths.
- Follow Madeora's Playful Precision style, restrained accent use, moderate rounding and subtle tactile depth.

## Approved decision 61 — Hybrid quick capture and full note editor (2026-11-19)
**Decision: C — Hybrid quick capture and full editor.**

- Make the prominent **+ New Note** action open a **compact, context-aware quick-capture editor** for entering an optional title and note body without navigating away from the Notes collection.
- Provide a clear **Expand editor** action that transitions into the approved adaptive focused note editor for longer writing, formatting, supported attachments and richer content.
- Preserve all typed content, title, cursor/selection state and intended destination when expanding or returning from the full editor; never discard a draft during the transition.
- Preselect the current Personal/Home workspace and folder when appropriate, while allowing an accessible destination change and respecting permissions.
- On desktop, use a comfortably sized dialog or anchored panel; on mobile, use a touch-friendly sheet or equivalent layout with keyboard-safe spacing.
- Offer clear save/create and cancel behavior, draft protection for accidental dismissal, useful validation and accessible focus management.
- Preserve Notes view mode, active folder, filters, search and scroll position after capture, with context-aware success feedback.
- Keep the initial capture surface lightweight; avoid overwhelming it with advanced formatting controls until users expand the editor.
- Follow the established Playful Precision design, contextual creation principles and adaptive note editor patterns.

## Approved decision 62 — Hybrid daily Habit Tracker and progress dashboard (2026-11-19)
**Decision: C — Hybrid daily tracker and progress dashboard.**

- Make the Habit Tracker page's primary content a **fast, approachable daily checklist** with obvious completion controls and readable habit names.
- Place **compact progress summaries** above or near the checklist, such as completed-today count and relevant streak/consistency information, without overwhelming the daily workflow.
- Provide a clearly discoverable **View trends** action for deeper historical progress and visual statistics rather than making charts dominate the default screen.
- Use Madeora's restrained Playful Precision visual style, tactile cards, consistent spacing, subtle completion animations and user-selected accent.
- Keep the habit list usable when there are many habits, with clear completed/pending states, touch-friendly controls and accessible non-color cues.
- Show a helpful empty state and prominent **+ New Habit** action for first-time users; avoid blank dashboards.
- Adapt summaries and checklist to mobile screens, with responsive stacking and legible progress metrics.
- Respect workspace boundaries and permissions, localization, accessible contrast, reduced-motion preferences and correct date/timezone interpretation.
- Treat progress numbers and sample streaks as illustrative design content, not fixed product values.

## Approved decision 63 — Adaptive individual habit rows (2026-11-19)
**Decision: C — Adaptive habit rows.**

- Present daily habits as **compact, consistent rows** that adapt their secondary information and quick actions to the habit's tracking type, rather than forcing every habit into a large card.
- For **binary habits**, emphasize an accessible one-tap completion control and concise optional context such as current streak or completed-today status.
- For **measurable habits**, display a restrained progress indicator with clear current-versus-target values and a convenient quick-increment control where appropriate.
- Keep row alignment, spacing, typography, corner rounding and primary tap targets consistent even when individual rows have different metadata.
- Use lightweight completion feedback, distinguish pending/partial/completed states without relying on color alone, and respect reduced-motion settings.
- Offer contextual access to habit details and editing without crowding each row with persistent action icons.
- Handle long names, localized progress units, varying targets and small screens gracefully; do not imply all habits share a single measurement type.
- Align with Decision 62's **daily checklist first, compact summaries second** hierarchy and Madeora's Playful Precision visual language.
- Ensure progress controls and status indicators are keyboard and screen-reader accessible and respect workspace permissions.

## Approved decision 64 — Adaptive weekly habit progress strip (2026-11-19)
**Decision: C — Adaptive weekly progress strip.**

- Use a **consistent seven-day progress strip** to visualize weekly habit consistency, preserving a recognizable day-by-day rhythm across habit types.
- For **binary habits**, display distinct completion checkmarks or equivalent non-color-only status indicators in the corresponding day cells.
- For **measurable habits**, display proportional fills representing each day's progress toward its configured target, with accessible numeric details on interaction or in adjacent text.
- Clearly distinguish **completed, partially completed, missed, not scheduled and future days** without implying that future days are failures; do not rely on color alone.
- Use restrained accent tones and subtle tactile cells consistent with Madeora's Playful Precision style, avoiding visually heavy charts in the daily tracker.
- Make the strip responsive, with readable weekday labels, adequate touch targets, sensible narrow-screen behavior and support for localized week starts and dates.
- Provide accessible descriptions for each day's status and progress, with keyboard navigation where day cells are interactive.
- Keep deeper historical analysis in the optional **View trends** experience approved in Decision 62, while preserving the checklist as the page's primary focus.
- Respect workspace permissions, correct timezone/date handling and reduced-motion preferences.

## Approved decision 65 — Adaptive habit completion micro-celebrations (2026-11-19)
**Decision: C — Adaptive micro-celebrations.**

- For **routine habit completion**, provide immediate, subtle feedback through a brief checkbox/checkmark transition, restrained highlight or similar satisfying micro-animation, without disrupting the habit list.
- For **meaningful milestones** such as completing all scheduled habits for the day, allow a slightly more celebratory but still compact moment (for example, a small sparkle or inline milestone message), not a full-screen interruption.
- Distinguish **partial progress** on measurable habits from reaching the actual daily target; reserve completion feedback for the appropriate state transition.
- Avoid repetitive confetti, excessive praise or attention-grabbing motion for each ordinary action, especially when completing many habits in succession.
- Preserve the user's position in the daily checklist, keep controls responsive, and provide clear Undo/correction feedback where appropriate.
- Respect **reduced-motion preferences** by replacing motion with instant, accessible state changes; ensure status is understandable without color, animation or sound.
- Use Madeora's Playful Precision visual language and the existing contextual feedback patterns approved for tasks and dashboard interactions.
- Keep milestone feedback optional and unobtrusive across mobile, desktop, light and dark themes.

## Approved decision 66 — Hybrid habit insights and calendar history (2026-11-19)
**Decision: C — Hybrid insights and calendar history.**

- Design the Habit Tracker's optional **View trends** experience around a balanced hierarchy of **compact summary metrics**, a **calendar-style activity history**, and progressively disclosed **per-habit detail charts**.
- Surface a small set of immediately understandable measures such as consistency and streaks, with clear labels and time-range context; avoid a dense analytics dashboard by default.
- Use a calendar heatmap/history grid to reveal day-by-day patterns, with distinct visual states for completed, partial, missed, not scheduled and future days, without relying on color alone.
- Let users inspect an individual habit for richer historical detail appropriate to its tracking type, including measurable progress where relevant, without forcing those charts into the overview.
- Provide an accessible time-range selector and readable legends/tooltips or equivalent text descriptions; honor localized dates, week starts and timezones.
- Keep the daily checklist approved in Decision 62 as the primary habit workflow, with trends as a clearly accessible secondary view.
- Ensure responsive chart layouts, accessible data alternatives, keyboard/touch navigation and readable light/dark contrast.
- Apply Madeora's Playful Precision visual language, user-selected accent and restrained motion; avoid making ordinary missed days feel punitive.
- Treat illustrated metrics and history values as examples, not fixed product targets or analytics definitions.

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
- Widget content: **DECIDED — adaptive hierarchy with consistent headers, summary-first small sizes and richer actionable large sizes**.
- Visual treatment: **DECIDED — Soft Neumorphism with pronounced tactile depth** (raised cards, deeper layered shadows, inset controls), **moderately rounded geometry** (widgets ~12–16px, controls ~6–10px), **balanced responsive spacing**, one user-selected accent and derived tonal variants, no fixed per-module colors.
- Ora: **DECIDED — optional insights widget plus unobtrusive, hideable global assistant launcher**, with shared context and no duplicate alerts.

## Engineering guardrails
Read `docs/product/Project-entry.md`, `docs/product/Modules.md`, `docs/product/Project-specification.md`, `docs/design/design-decisions.md`, `CLAUDE.md`, and current dashboard/widget implementation before coding. Binding product specification is read-only; this document is a proposed redesign plan, not authorization to contradict it. Reuse `packages/design-tokens`, `packages/icons`, and existing dashboard persistence where possible. Avoid breaking existing user layouts; plan migration/versioning if widget geometry or schema changes. Add Playwright interaction tests and visual snapshots, plus RLS/privacy checks where data access is touched.

## Next action
Obtain screenshots or a live interactive review of **normal dashboard**, **edit dashboard**, **widget gallery**, and **widget configuration** at desktop and mobile widths. Refine this plan based on actual visuals and implementation details before starting code.
