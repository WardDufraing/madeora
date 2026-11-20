# Madeora Marketing Website — Living Design Specification

> Status: In discovery. Decisions 01–10 confirmed on 2026-11-21. This is a design direction, **not authorization to implement unfinished decisions**.
> Product: Madeora | Marketing domain: madeora.studio | Repository: WardDufraing/madeora

## Purpose

Create a public-facing marketing website that quickly communicates what Madeora is, demonstrates its usefulness, and guides visitors toward signing up when appropriate. Madeora is a modular personal-life and household coordination application for individuals, couples, families, and shared households, with personal and shared Home experiences.

The website must not resemble an enterprise productivity dashboard or imply that all functionality is available without checking the current implementation.

## Confirmed decisions

### Decision 01 — Overall first impression (CONFIRMED)

**Selection: A + D, with the polish of C.**

- **Calm and effortless (A):** spacious, uncluttered composition, clear hierarchy, considered typography, comfortable whitespace.
- **Warm and human (D):** welcoming visual language, relatable everyday-life storytelling, friendly but restrained personality, inclusive presentation of individuals and households.
- **Premium and innovative polish (C):** refined motion, high-quality interface previews, precise details, and sophisticated composition without an overly futuristic or corporate appearance.
- The design should feel like a premium lifestyle product rather than conventional business productivity software.
- Avoid noisy gradients, excessive floating decorations, heavy animations, or a cold enterprise aesthetic.

### Decision 02 — Homepage hero (CONFIRMED)

**Selection: C + D — Interactive product showcase with an editorial split layout.**

- Combine a strong, immediately understandable headline and primary call-to-action with a prominent composition of Madeora interface components.
- Use a split/editorial arrangement on suitable desktop widths: copy and CTA on one side, product showcase on the other.
- The showcase should demonstrate how Madeora brings multiple parts of everyday life together, potentially including tasks, calendars, habits, shopping lists, and shared Homes.
- Favor genuine product UI or faithfully implemented components aligned with the application's current design system. Do not invent functionality.
- Subtle, purposeful animations can introduce, connect, or reveal interface elements; maintain legibility and support reduced-motion preferences.
- On smaller screens, adapt to a readable stacked layout with an effective visible CTA and appropriately scaled product preview.
- Headline examples discussed (not approved final copy): “Everything in life, finally in sync.” and “One beautiful place for everyday life.”

### Decision 03 — Hero headline (CONFIRMED)

**Selection: B — “Everything in life, finally in sync.”**

- Use this exact sentence as the primary homepage hero headline, unless the user explicitly revises it.
- The supporting copy should clarify that Madeora brings personal and shared everyday organization together; final supporting copy is still undecided.
- Preserve legibility and natural line breaks across responsive sizes.

### Decision 04 — Hero supporting copy (CONFIRMED)

**Selection: D — Balanced and benefit-driven.**

Use this exact supporting paragraph beneath the hero headline:

> Your plans, routines, and shared moments, all in one place. Madeora makes it easier to stay organized, together or on your own.

- Preserve the distinction between personal and shared use; do not imply a Home is required.
- Final responsive line wrapping and visual styling may adapt to the design, but do not silently rewrite the approved wording.

### Decision 05 — Hero calls to action (CONFIRMED)

**Selection: B — Signup + exploration.**

- Primary CTA label: **Get started for free**. Intended action: enter the signup/onboarding flow when available; verify the destination and actual free offering before launch.
- Secondary CTA label: **Explore features**. Intended action: lead to the marketing site's feature explanation, either a homepage section or a dedicated feature page (destination to be decided).
- Present a clear primary/secondary hierarchy, with both actions accessible on desktop and mobile.
- Do not add a separate product demo or replace these labels without a later decision.
- Do not claim signup or a free plan is live until verified.

### Decision 06 — Hero product showcase (CONFIRMED)

**Selection: C + D — Dashboard composition with Personal/Home transition.**

- Anchor the hero visual in a recognizable, authentic Madeora dashboard preview.
- Layer selected modular widget cards around or slightly outside the dashboard frame for depth and premium visual impact, without obscuring important content.
- Showcase the distinction between a personal dashboard and a shared Home dashboard through a clear, tasteful transition; do not imply that private personal content is automatically shared.
- Keep the personal/Home states grounded in real capabilities and synthetic example data.
- The exact transition trigger, timing, mobile fallback, and widget selection remain open design details; do not assume a specific autoplay or interactive behavior yet.
- Respect reduced-motion preferences and maintain usable static representations.

### Decision 07 — Personal/Home transition interaction (CONFIRMED)

**Selection: C — Automatic transition plus manual toggle.**

- The hero showcase automatically alternates between Personal and Home dashboard states to demonstrate both experiences without requiring visitor interaction.
- Provide a clearly labeled, keyboard-operable **Personal / Home** toggle so visitors can select either state themselves.
- Pause or stop automatic transitions after manual interaction so the selected view remains under visitor control.
- Respect `prefers-reduced-motion`: avoid automatic animated transitions for visitors requesting reduced motion, while keeping manual switching available.
- Keep transitions gentle, readable, and non-disruptive; avoid layout shifts and protect the clarity of the headline and CTAs.
- Exact autoplay interval, transition duration/easing, and pause behavior for hover/focus are not yet specified and should be resolved during interaction design.

### Decision 08 — Hero widget selection (CONFIRMED)

**Selection: C — Context-aware widgets.**

- **Personal dashboard:** feature tasks, habits, calendar, and goals.
- **Home dashboard:** feature chores, shared calendar, shopping lists, and meal planning.
- Transition between these distinct sets when switching Personal/Home; the change should communicate genuine differences in use cases, not just a cosmetic theme change.
- Keep the composition uncluttered and visually hierarchical: a recognizable dashboard anchors the scene while a small number of highlighted widgets can float beyond it.
- Use realistic, synthetic example content; never expose real user data or suggest that private personal items automatically become shared.
- Exact arrangement, priority of featured cards, and mobile simplification remain to be decided.

### Decision 09 — Hero showcase animation style (CONFIRMED)

**Selection: D — Balanced premium motion.**

- Use refined, smooth transitions between Personal and Home dashboard states.
- Introduce changing widgets with gentle, staggered fade/slide entrances; avoid theatrical or prolonged sequences.
- Convey subtle depth through layering and restrained shadows, with little to no perpetual floating movement.
- Keep the headline, supporting copy, and CTAs stable while the showcase animates.
- Ensure transitions remain readable and responsive; avoid distracting motion, layout shift, and performance-heavy effects.
- Respect reduced-motion preferences and the previously confirmed manual toggle/auto-transition behavior.
- Exact durations, easing, stagger offsets, and autoplay interval remain implementation details to validate later.

### Decision 10 — Marketing color identity (CONFIRMED)

**Selection: Use Madeora's existing default colors, not a new marketing-specific palette.**

- Reuse the canonical `@madeora/design-tokens` package rather than hardcoding a parallel color system.
- The current default accent is purple `#8057f5` (`packages/design-tokens/src/palette.ts`); apply accessible derived accent variants via `deriveAccent`.
- Current light-theme neutrals (`packages/design-tokens/src/neutral.ts`): page `#f7f8fc`, surfaces `#ffffff`, primary text `#151a29`, muted text `#667085`, borders `#e6e9f1`.
- Support dark mode consistently if selected in a later decision; do not assume the marketing site must have a theme switch.
- Treat repository tokens as authoritative if their values change. Preserve the warm, human tone through imagery, spacing, typography, and composition rather than introducing an unrelated color palette.

## Implementation principles for Claude Code

1. **Do not implement based solely on this partial specification.** Wait for explicit approval of implementation or an implementation-ready milestone.
2. Treat sections marked CONFIRMED as binding design direction; examples and future topics are not decisions.
3. Inspect the actual repository structure, existing marketing routes/app, design tokens, icon package, and current product features before making implementation choices.
4. Keep marketing claims grounded in implemented functionality and clearly distinguish available, upcoming, and conceptual features.
5. Ensure responsive behavior, keyboard accessibility, semantic markup, strong contrast, and reduced-motion handling.
6. Optimize for performance and maintainability: avoid unnecessary animation libraries, oversized assets, and heavy client-side rendering.
7. Preserve the existing application, authentication, and personal/Home privacy boundaries. Marketing previews must use synthetic data.
8. Do not assume a specific CTA destination, signup availability, pricing, launch status, or marketing technology stack until verified and decided.

## Open decisions (NOT YET APPROVED)

- Exact CTA destinations and signup/free-plan availability (CTA labels and intended actions confirmed).
- Primary navigation and page architecture.
- Typography, illustration/photography strategy, and Ora's role (brand colors confirmed as existing Madeora defaults).
- Product showcase autoplay timing, exact widget arrangement, mobile presentation, and precise motion timings (balanced premium motion confirmed).
- Feature storytelling and personal vs. Home use-case presentation.
- Social proof, trust/privacy messaging, FAQ, and footer.
- Pricing and plans presentation, if appropriate.
- SEO, localization, analytics/consent, and launch strategy.

## Decision log

| ID | Topic | Selection | Status |
| --- | --- | --- | --- |
| 01 | Overall first impression | Calm + warm/human + premium polish (A + D + C) | Confirmed |
| 02 | Homepage hero | Interactive product showcase + editorial split (C + D) | Confirmed |
| 03 | Hero headline | Everything in life, finally in sync. (B) | Confirmed |
| 04 | Hero supporting copy | Balanced and benefit-driven (D) | Confirmed |
| 05 | Hero calls to action | Get started for free + Explore features (B) | Confirmed |
| 06 | Hero product showcase | Dashboard + floating widgets with Personal/Home transition (C + D) | Confirmed |
| 07 | Personal/Home transition interaction | Automatic switching + manual toggle (C) | Confirmed |
| 08 | Hero widget selection | Context-aware: Personal tasks/habits/calendar/goals; Home chores/shared calendar/shopping/meal planning (C) | Confirmed |
| 09 | Hero animation style | Balanced premium motion: smooth transitions, staggered entrances, restrained depth (D) | Confirmed |
| 10 | Marketing colors | Reuse Madeora's default design tokens and purple accent | Confirmed |

## Update protocol

After each new user decision, append the confirmed choice to the relevant section and decision log. Do not silently promote a recommendation into a confirmed requirement. Keep this file as the source of truth for marketing-site design decisions and cross-check implementation with the current product and repository documentation.
