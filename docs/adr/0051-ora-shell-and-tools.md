# ADR 0051: Ora shell, character, settings and the typed tools layer

- **Status:** Proposed for S45 within the approved architecture (authorization C, frontend strategy B, forms and validation A, the 13 Oct 2026 decision that Ora starts with no language model and no free text), `design/design-decisions.md` and the Ora design handoff (17 Oct 2026). Two wording changes wait for the owner's confirmation (see "Open values").
- **Date:** 2026-11-13
- **Step:** S45 (brief: `plans/steps/S45-brief.md`).

## Context

Ora is the spec's persistent helper. The handoff fixes its look (a small floating character, nine palettes, eight expressions, three motion modes) and its place (a button at the bottom-right of every signed-in page that opens a speech bubble on larger screens and a bottom sheet on phones). The spec requires that Ora can be hidden and disabled by each member, that it stays visible with a calm "temporarily unavailable" state when its service fails, that a short skippable introduction runs once, and that Ora never does more than the member may do.

## Decision

**Tools are the only way Ora acts.** `apps/web/src/ora/tools` is a typed registry. Every tool names where it exists (Personal, one Home, or anywhere) and, for a Home, the permission-engine action that allows it (`decideHomeAction`). `GET /api/v1/ora/tools` lists, and `POST /api/v1/ora/tools` runs, only what the signed-in person may use in that place now. Both resolve the identity and the membership (with the Owner's grants) from the database on every call using the person's own session; the Home id from the browser only names which Home to look up. A tool that does not exist, a Home tool in Personal, a tool the role lacks and a Home the person does not belong to all answer the same 403. In S45 the tools open pages (`navigate`) or return what Ora can do (`read`); nothing changes data. Tools that change data (editable preview, confirmation, Undo) are S47 and will add their own kind to the same registry.

**Settings are the person's own rows.** `ora_preferences` (one row per person: enabled, motion mode, introduction state, Personal colour) and `ora_home_palettes` (one row per person per Home, deleted with the membership) have own-row RLS; nobody, an Owner included, reads or sets another member's. Disabling hides Ora and keeps every setting. A missing row means the defaults (shown, gentle motion, introduction unseen, Heather). The palette keys are the nine stable keys of `@madeora/design-tokens` (`ora.ts`), checked in SQL and in the API.

**The character is the handoff, ported.** `OraCharacter` renders the approved SVG and CSS as a typed component with unique gradient ids per instance, all colours delivered as CSS variables from the design tokens, brief reactions that return to calm floating, the three motion modes, and the system reduced-motion setting always winning. Expression faces are swapped as SVG path attributes (the reference's CSS `d:` transitions work in Chromium and Firefox only).

**The surface is not modal and keeps its state.** The bubble or sheet stays mounted while closed, so Ora's state survives navigation and reopening. It closes with its button, a click outside, Escape or a swipe down on the sheet; focus moves in on opening and back to the button on closing. Core pages never wait for Ora: if its settings or tools cannot be read, Ora offers defaults or the unavailable state, with Retry and links to the pages that work without it.

## Open values

1. The per-Home colour choice replaces the spec's "fixed visual identity" wording (design review item 2; handoff confirms it).
2. The mascot-style character relaxes "not a full character" (design decisions, point 3).
3. Ephemeral Ora UI state is React context for now; S46 may move it to Zustand if the dashboard widget needs it.

## Consequences

- Ora's settings are not part of the privacy export yet; they go with the account on deletion (cascade). The export will include them together with history and memories in S47.
- Display-only Ora and child sessions are not in S45.
