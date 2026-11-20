# Madeora Marketing Website — Living Design Specification

> Status: In discovery. Decisions 01–06 confirmed on 2026-11-21. This is a design direction, **not authorization to implement unfinished decisions**.
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
- Brand colors, typography, illustration/photography strategy, and Ora's role.
- Product showcase transition trigger, animation intensity, widget selection, and mobile presentation (composition and Personal/Home transition confirmed).
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

## Update protocol

After each new user decision, append the confirmed choice to the relevant section and decision log. Do not silently promote a recommendation into a confirmed requirement. Keep this file as the source of truth for marketing-site design decisions and cross-check implementation with the current product and repository documentation.
