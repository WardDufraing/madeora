# UX redesign — status against the redesign doc and remaining phases

Source of intent: `docs/design/dashboard-ux-ui-redesign.md` (Decisions 1–71; not 72). The decision-to-component matrix, gaps and Ward's answers already exist in `plans/steps/UX00-redesign-plan-brief.md` (§3 matrix, §4 phases, §7 review corrections, §8 answers). This file does not repeat them; it records what is done and what is next. Updated by each phase.

## Status

| Phase    | Branch / PR                               | State                                                                                                   |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| UX1a     | `feat/redesign-design-foundations` (#113) | merged: tokens, depth, radius, motion, shared primitives                                                |
| UX2-data | `feat/dashboard-drafts-data` (#114)       | merged: drafts, 10-version history, Home views (data only)                                              |
| UX3a     | `feat/work-periods-events` (#112)         | merged: work periods as flagged events (backend only)                                                   |
| UX4a     | `feat/atomic-list-first-task` (#111)      | merged: list + first task RPC and route (backend only)                                                  |
| UX8a     | `feat/display-protected-session` (#115)   | merged: 5-minute protected-action sessions and ambient timing (backend only)                            |
| UX1b     | `feat/redesign-app-shell-navigation`      | **this PR**: sidebar, All modules, shortcuts, mobile bottom bar and Create menu (`UX1b-brief.md`)       |
| UX1c     | next                                      | hero header (D12/D40), workspace switcher moved into the sidebar (D11/D41), Ora launcher (D13)          |
| UX2a     | `feat/dashboard-widget-header`            | **PR open**: widget header and menu, settings panel, empty-state modes, size variants (`UX2a-brief.md`) |
| UX2b     | Opus                                      | edit mode on the drafts API, gallery, presets, reflow preview                                           |
| UX2c     | Opus                                      | presets and history UI                                                                                  |
| UX2d     | Opus                                      | Home views and suggestions UI                                                                           |
| UX3b     | UI on UX3a                                | calendar modal, borderless look, event preview, work-period blocks                                      |
| UX4b     | UI on UX4a                                | Tasks workspace, + New Task, rows, side panel                                                           |
| UX5      |                                           | Habits                                                                                                  |
| UX6      |                                           | Shopping                                                                                                |
| UX7      | parked                                    | Notes: no spec (Ward, 2026-11-19)                                                                       |
| UX8b     | Opus                                      | wall-display UI on UX8a, weather only after Ward approves a provider                                    |
| UX9      |                                           | polish, visual regression, NL/EN and axe sweep                                                          |

UX3b–UX6 are independent of UX2 and of each other after UX1b.

## Docs to flag to Ward

- `docs/production-migrations.md` lists none of `20261219090000` to `20261222090000` (checked 2026-11-25). PR 116 covers only the first; the other three (`20261220`, `20261221`, `20261222`) still need adding by the owner's docs commit.
- `plans/roadmap.md` has no UX rows yet; UX00 §7 says they are added in their own PR after approval.

## Progress notes

- 2026-11-25: status brief written; UX1b started on Sonnet (UI only, no RLS or data).
