# Madeora design decisions (supplement to the specification)

Recorded 13 October 2026 from Ward in the project thread. Where these notes differ from
`Initial Documentation/Project-specification.md` (UI / UX Style Guide and the Ora visual
identity sections), these notes win. The Initial Documentation files themselves are left unchanged.

## Reference mockups
- `mockups/household-dashboard-light-dark.png` — **the** styling reference for Madeora
  (household dashboard in dark and light, expanded and collapsed sidebar). Use as visual
  inspiration, not literal data or pixel-perfect spec.
- `mockups/website-builder-dashboard-NOT-FOR-USE.png` — the unrelated website-builder
  dashboard. Kept only for traceability; do not use it as a design reference (spec agrees).

## Decisions
1. **Purple is a placeholder for the accent colour.** The purple in the mockups (buttons,
   checkboxes, active states, highlights) stands for the user's chosen accent colour and must
   be implemented through accent tokens, never hard-coded.
2. **Sidebar has two states:** open (icons + labels, ~240px) and closed (icons only, ~72px),
   as shown in the mockup. Matches the spec; preference is remembered between sessions.
3. **Ora may be somewhat mascot-like.** This relaxes the spec's "abstract animated identity,
   not a full character/mascot" (approved 12 October 2026). A friendly face/character such as
   the one in the mockup is allowed. Everything else about Ora's identity still applies:
   consistent signature look independent of member accents, restrained purposeful motion,
   listening / thinking / helping / celebrating / resting states, reduced-motion fallbacks,
   unobtrusive and dismissible.

## Spec points the mockup does not follow (spec still applies)
- **Ora card background:** the mockup gives the Ora card a purple wash. The spec allows a
  gradient/glow only on the page background, so the card needs a solid surface. Not changed.
- **"Memories" in the sidebar** is replaced by **Photos** (Modules.md, 13 October 2026).

## Open
- Ora's fixed appearance and the Madeora brand mark (logo) need their own colour that does not
  follow the user accent. Not yet chosen.
