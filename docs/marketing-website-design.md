# Madeora Marketing Website — Living Design Specification

> Status: Design discovery reopened (2026-11-25). Decisions 01–25 confirmed. First iteration retained as a milestone; further marketing design decisions are in progress. Await explicit implementation instruction.
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
- Both light and dark modes with a visitor-controlled toggle are confirmed in Decision 11.
- Treat repository tokens as authoritative if their values change. Preserve the warm, human tone through imagery, spacing, typography, and composition rather than introducing an unrelated color palette.

### Decision 11 — Marketing website theme modes (CONFIRMED)

**Selection: C — Light and dark modes with a theme toggle.**

- Support both light and dark themes using Madeora's existing design tokens; do not create a separate marketing theme palette.
- On an initial visit without a saved preference, use the visitor's operating-system `prefers-color-scheme` preference.
- Provide a clearly discoverable, accessible light/dark toggle; persist the visitor's explicit selection across visits.
- Ensure the entire marketing website, hero product previews, and interactive elements work in both modes, with accessible contrast and no theme flash where practical.
- Use light mode as the primary design/reference presentation, while treating dark mode as a fully supported equivalent.
- The exact toggle placement and visual control treatment remain to be decided.

### Decision 12 — Marketing typography (CONFIRMED)

**Selection: D — Existing Madeora fonts with editorial styling.**

- Reuse the existing font families defined in `@madeora/design-tokens`; do not introduce a separate marketing font identity without explicit approval.
- Give the marketing website more expressive headline sizes, refined letter spacing, and stronger editorial hierarchy than ordinary application screens.
- Maintain comfortable line lengths, readable body typography, and responsive type scaling across devices.
- Keep typography coherent with the Madeora application and the calm, warm, premium design direction.
- Specific font sizes, weights, and responsive scale are implementation details to validate against existing tokens and accessibility requirements.

### Decision 13 — Homepage navigation structure (CONFIRMED)

**Selection: D — Balanced navigation.**

- Primary marketing navigation: **Features**, **Solutions**, **How it works**, and **Pricing**.
- Include **Log in** and a visually prominent **Get started** action, with clear distinction between account access and signup.
- **Solutions** should be designed to accommodate audience-specific use cases such as individuals, couples, families, and housemates; exact dropdown entries, destination pages, and interaction behavior are not yet approved.
- Keep the desktop header visually restrained despite the broader information architecture; provide a usable, accessible compact navigation on smaller screens.
- Exact page routes, whether some items link to homepage sections, and the details of the pricing offering remain open decisions. Do not imply that paid plans or pricing are live without verification.

### Decision 14 — Navigation header behavior (CONFIRMED)

**Selection: D — Adaptive sticky header.**

- At the top of the page, use a spacious header visually integrated with the hero.
- On scroll, retain the header at the top of the viewport and transition to a slightly more compact presentation with a subtle theme-aware surface and restrained backdrop blur.
- Keep navigation and account actions accessible throughout scrolling; preserve readable contrast in both themes.
- Avoid layout shifts, dramatic resizing, and distracting motion; respect reduced-motion preferences and provide a solid surface fallback for blur.
- Exact scroll threshold, dimensions, transition timing, and mobile menu treatment remain open implementation details.

### Decision 15 — Solutions dropdown design (CONFIRMED)

**Selection: D — Hybrid premium mega menu.**

- Use a two-column desktop dropdown: a compact audience navigation column with Madeora icons and links for Individuals, Couples, Families, and Housemates; and a featured product-storytelling panel.
- The featured panel should use a faithful Madeora product preview and introduce Personal spaces and shared Homes, with an action to explore how Madeora works.
- Illustrative copy from the selected concept: “Madeora for you”, “Life works better together.” and “Discover Personal spaces and shared Homes.” Final menu copy and destination routes are not separately approved.
- Use existing Madeora tokens, typography and icons in both themes. Provide keyboard-accessible disclosure, focus handling, Escape dismissal, and a compact mobile equivalent; avoid hover-only interaction.
- Do not create dead links or imply unimplemented audience pages exist. Resolve destinations against existing routes or defer them explicitly.

### Decision 16 — Marketing website page architecture (CONFIRMED)

**Selection: C + D — Hybrid storytelling website with individual module pages from the start.**

- Create a comprehensive homepage with hero, feature highlights, audience overview, how it works, pricing preview where verified, FAQ and CTA.
- Provide dedicated Features, How it works, Pricing and audience pages for Individuals, Couples, Families and Housemates.
- Include individual landing pages for major Madeora modules from the initial website iteration, with Calendar, Tasks, Habits, Shopping, Meal planning and Ora as illustrative candidates. Verify availability and agree the final module inventory before implementation.
- Connect homepage highlights and navigation to relevant deeper pages; avoid duplicate thin content, dead links and unsupported product claims.
- Exact URL structure, page templates, final module inventory, pricing details and content remain open.

### Decision 17 — Features navigation dropdown (CONFIRMED)

**Selection: D — Categorized premium mega menu with featured product panel.**

- Organize feature links into meaningful categories, with compact icons and labels, alongside a featured product panel and an All features link.
- Match the Solutions mega menu's visual language, existing design tokens, typography, spacing and theme support.
- The Personal life and Shared living categories and Meet Ora panel are illustrative, not final approved contents. Categories must not imply that modules are restricted to one space when they are not.
- Allow the featured panel to highlight Ora or another major feature in future; confirm its initial content separately.
- Provide keyboard-accessible disclosure, focus handling, Escape dismissal and a responsive mobile equivalent; avoid hover-only interaction and dead links.
- Final category labels, module inventory, featured content and exact routes remain open.

### Decision 18 — Feature categorization (CONFIRMED)

**Selection: D — Hybrid functional and benefit-driven categories.**

- Use concise, recognizable functional category names in navigation and more expressive benefit-driven supporting copy on the homepage, feature overview and module pages.
- Proposed category examples: Plan & organize, Grow & improve, Live together, Collect & remember, and Powered by Madeora. These labels and module assignments remain illustrative until separately confirmed.
- Keep Personal and Home as overarching product concepts, not mutually exclusive feature categories. Do not misrepresent module availability across spaces.
- Maintain consistent categorization across navigation and marketing pages, and verify module availability against the repository.
- Final category names, assignments and module inventory remain open.

### Decision 19 — Homepage feature showcase layout (CONFIRMED)

**Selection: D — Bento overview followed by editorial storytelling.**

- Use a premium responsive bento grid after the hero to introduce feature categories with varied card sizes, expressive typography and faithful Madeora product previews.
- Follow the overview with spacious editorial sections explaining distinctive connected experiences rather than repeating every module. Personal/Home, customization, shared living and Ora are proposed storytelling topics, subject to final content decisions and verified availability.
- Link feature highlights to relevant dedicated pages. Use existing theme tokens and synthetic preview data; avoid generic dashboard imagery, unsupported claims and decorative motion that impairs readability.
- Ensure logical reading order, responsive stacking, keyboard accessibility and reduced-motion support.
- Exact card composition, featured modules, section copy and editorial sequence remain open.

### Decision 20 — Product visualization style (CONFIRMED)

**Selection: D + C — Layered editorial product compositions with selective lifestyle device mockups.**

- Use faithful Madeora application interfaces with enlarged components, overlapping layers, restrained depth and controlled motion as the primary visual language.
- Homepage: layered editorial compositions; bento cards: isolated enlarged components; individual feature pages: detailed product previews; audience pages: occasional lifestyle device mockups; How it works: authentic application screenshots.
- Lifestyle photography should complement rather than obscure the product. Use the redesigned Madeora interface as the source of truth, synthetic preview data, and existing design tokens in both themes.
- Do not use third-party dashboard imagery as final product visuals or depict unsupported functionality. Optimize assets, preserve legibility and respect reduced-motion preferences.
- Exact photography art direction, asset production method and individual compositions remain open.

### Decision 21 — Lifestyle photography art direction (CONFIRMED)

**Selection: D — Warm editorial realism.**

- Combine premium editorial composition with authentic everyday moments, diverse households, natural expressions and believable lived-in homes.
- Favor soft natural daylight, warm shadows, natural materials, restrained earthy photographic tones and intentional negative space. These photographic tones are not additional brand colors.
- Integrate devices naturally into everyday activities; keep Madeora product depictions faithful to the redesigned application.
- Avoid generic corporate stock photography, exaggerated poses, unrealistically perfect households and artificial purple lighting.
- Reference imagery is moodboard inspiration only; final assets, licensing and production methods remain open.

### Decision 22 — Ora's marketing presence (CONFIRMED)

**Selection: D — Premium brand companion with dedicated storytelling.**

- Give Ora a dedicated homepage storytelling section, individual landing page, featured position in the Features mega menu and subtle contextual appearances on relevant pages.
- Present Ora as a thoughtful companion supporting personal and household organization, not as the primary AI-first positioning of Madeora.
- Reuse Ora's actual visual identity and fixed accent; conceptual illustrations are not final assets. Explain capabilities, personality and privacy using verified product behavior only.
- Keep appearances restrained, accessible and consistent with both themes. An interactive public website chatbot or guide is not approved by this decision.
- Final copy, visual compositions and exact contextual placements remain open.

### Decision 23 — Personal & Home storytelling (CONFIRMED)

**Selection: D + C — Connected spaces visualization with lifestyle storytelling.**

- Create a signature connected-spaces illustration explaining a Personal space, multiple shared Homes and selective sharing, complemented by warm editorial realism photography.
- Explain the relationship between spaces rather than repeating the hero's interactive space switcher. Emphasize personal privacy and user-controlled sharing only to the extent verified by the implemented permission model.
- Use faithful Madeora design tokens, synthetic household examples and accessible explanatory text; ensure the diagram remains understandable on mobile and in both themes.
- The illustration may be reused on How it works and relevant audience pages; onboarding changes are outside this marketing specification.
- Sample household names, headlines, final compositions, exact copy and photography assets remain illustrative or open.

### Decision 24 — Customization storytelling (CONFIRMED)

**Selection: D — Editorial storytelling with an embedded interactive playground.**

- Combine benefit-driven editorial copy, faithful layered product visuals and a lightweight interactive dashboard preview.
- Allow visitors to experiment with supported accent colors, light/dark appearance, dashboard layouts and widget selection without creating an account. Include a reset action.
- Use synthetic data and isolated preview state; never modify actual application settings or the surrounding marketing site's theme or accent.
- Match the redesigned application and verify supported controls, layouts and widgets before implementation. Conceptual sample presets and copy are not final product specifications.
- Ensure responsive, keyboard-accessible controls, reduced-motion support and a useful static fallback. Avoid unnecessary client-side weight.
- Final copy, exact controls, composition and preview implementation remain open.

### Decision 25 — Homepage audience showcase (CONFIRMED)

**Selection: D — Editorial audience selector with product storytelling.**

- Present Individuals, Couples, Families and Housemates through a manually controlled audience selector, combining warm editorial realism photography, tailored benefit-driven copy and faithful audience-relevant product previews.
- Use layered, spacious editorial compositions on desktop and responsive stacking on mobile. Provide accessible keyboard-operable selection controls and avoid automatic rotation.
- Give every audience a direct link to its dedicated landing page; keep all audiences discoverable without relying solely on interaction.
- Use synthetic preview data and verify feature availability. Sample headlines, household names, feature assignments and reference photography are illustrative only.
- Final default audience, copy, assets and exact layout remain open.

## First iteration handoff

The user concluded the first design iteration after Decision 15, then reopened design discovery at Decision 16 while the application redesign is being implemented. This handoff is a historical milestone, not the final marketing implementation scope. When instructed to build, Claude Code may implement the confirmed visual foundation, responsive hero and Personal/Home showcase, theme handling, adaptive header, and Solutions mega menu. Keep the existing app intact. Review current repository conventions before coding. Treat unresolved page architecture, pricing, signup availability, and remaining marketing content as deferred; do not fabricate claims or publish incomplete navigation. Where a safe implementation detail is necessary (e.g. motion timing, responsive layout), choose a reasonable accessible default and document it. Validate both themes, mobile and desktop layouts, keyboard interaction, reduced motion, and relevant repository checks. Report remaining gaps before launch.

## Implementation principles for Claude Code

1. Design discovery is reopened. Wait for explicit implementation instruction; do not treat deferred decisions as approved or the earlier milestone as launch authorization.
2. Treat sections marked CONFIRMED as binding design direction; examples and future topics are not decisions.
3. Inspect the actual repository structure, existing marketing routes/app, design tokens, icon package, and current product features before making implementation choices.
4. Keep marketing claims grounded in implemented functionality and clearly distinguish available, upcoming, and conceptual features.
5. Ensure responsive behavior, keyboard accessibility, semantic markup, strong contrast, and reduced-motion handling.
6. Optimize for performance and maintainability: avoid unnecessary animation libraries, oversized assets, and heavy client-side rendering.
7. Preserve the existing application, authentication, and personal/Home privacy boundaries. Marketing previews must use synthetic data.
8. Do not assume a specific CTA destination, signup availability, pricing, launch status, or marketing technology stack until verified and decided.

## Open decisions (NOT YET APPROVED)

- Exact CTA destinations and signup/free-plan availability (CTA labels and intended actions confirmed).
- Exact navigation destinations, final Solutions menu copy, URL structure, module inventory and page templates (hybrid multi-page architecture with module pages confirmed).
- Illustration/photography strategy and Ora's role (brand colors and font families confirmed as existing Madeora defaults; editorial headline treatment confirmed).
- Product showcase autoplay timing, exact widget arrangement, mobile presentation, and precise motion timings (balanced premium motion confirmed).
- Feature storytelling and personal vs. Home use-case presentation.
- Social proof, trust/privacy messaging, FAQ, and footer.
- Pricing and plans presentation, if appropriate.
- SEO, localization, analytics/consent, and launch strategy.

## Decision log

| ID  | Topic                                | Selection                                                                                                   | Status    |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------- |
| 01  | Overall first impression             | Calm + warm/human + premium polish (A + D + C)                                                              | Confirmed |
| 02  | Homepage hero                        | Interactive product showcase + editorial split (C + D)                                                      | Confirmed |
| 03  | Hero headline                        | Everything in life, finally in sync. (B)                                                                    | Confirmed |
| 04  | Hero supporting copy                 | Balanced and benefit-driven (D)                                                                             | Confirmed |
| 05  | Hero calls to action                 | Get started for free + Explore features (B)                                                                 | Confirmed |
| 06  | Hero product showcase                | Dashboard + floating widgets with Personal/Home transition (C + D)                                          | Confirmed |
| 07  | Personal/Home transition interaction | Automatic switching + manual toggle (C)                                                                     | Confirmed |
| 08  | Hero widget selection                | Context-aware: Personal tasks/habits/calendar/goals; Home chores/shared calendar/shopping/meal planning (C) | Confirmed |
| 09  | Hero animation style                 | Balanced premium motion: smooth transitions, staggered entrances, restrained depth (D)                      | Confirmed |
| 10  | Marketing colors                     | Reuse Madeora's default design tokens and purple accent                                                     | Confirmed |
| 11  | Marketing themes                     | Both light and dark, system preference initially, manual toggle (C)                                         | Confirmed |
| 12  | Marketing typography                 | Existing Madeora fonts with editorial headline styling (D)                                                  | Confirmed |
| 13  | Homepage navigation                  | Features, Solutions, How it works, Pricing, Log in, Get started (D)                                         | Confirmed |
| 14  | Navigation header behavior           | Adaptive sticky header: spacious initially, compact on scroll (D) | Confirmed |
| 15  | Solutions dropdown design | Hybrid premium mega menu with audience links and product storytelling (D) | Confirmed |
| 16 | Marketing page architecture | Hybrid storytelling homepage plus dedicated audience and module pages (C + D) | Confirmed |
| 17 | Features navigation dropdown | Categorized premium mega menu with featured product panel (D) | Confirmed |
| 18 | Feature categorization | Hybrid functional categories with benefit-driven supporting copy (D) | Confirmed |
| 19 | Homepage feature showcase | Premium bento overview followed by editorial storytelling (D) | Confirmed |
| 20 | Product visualization style | Layered editorial product compositions with selective lifestyle mockups (D + C) | Confirmed |
| 21 | Lifestyle photography | Warm editorial realism (D) | Confirmed |
| 22 | Ora marketing presence | Premium brand companion with dedicated storytelling (D) | Confirmed |
| 23 | Personal & Home storytelling | Connected spaces visualization with lifestyle storytelling (D + C) | Confirmed |
| 24 | Customization storytelling | Editorial storytelling with embedded interactive playground (D) | Confirmed |
| 25 | Homepage audience showcase | Editorial audience selector with product storytelling (D) | Confirmed |

## Update protocol

After each new user decision, append the confirmed choice to the relevant section and decision log. Do not silently promote a recommendation into a confirmed requirement. Keep this file as the source of truth for marketing-site design decisions and cross-check implementation with the current product and repository documentation.
