# Madeora — Project Entry Point

**Product:** Madeora · **Website:** madeora.studio · **Assistant:** Ora  
**Documentation set:** v2 split · 13 October 2026 · **Status:** Working product requirements; not a statement of implementation completion

> **For Claude and new contributors:** Read this file first. Then read `Modules.md` for feature scope and the relevant full sections of `Project-specification.md` before writing code. Never treat an overview as a replacement for approved detailed requirements.

## START HERE — Madeora in five minutes

**What it is.** Madeora (`madeora.studio`) is a modular personal-life and household coordination application. A person can use it alone or belong to several **Homes** (households). It brings together planning, chores, food, habits, pets, photos and related tools through configurable dashboards. **Ora** is its permission-aware assistant. A **Household Display** is a dedicated shared-screen experience, not a normal logged-in personal session.

**Who uses it.** Individuals, couples, families (including guardian-managed children), and shared households. A single person may participate in several Homes without merging their private data or leaking information between them.

**What success looks like.** A member can sign in, organize personal life, join a Home, collaborate on authorized records, personalize widgets, connect Google Calendar, and see useful up-to-date information on personal and shared screens. Cross-module workflows must actually work. The app must never silently expose private data, overwrite a calendar conflict, or let Ora act beyond its permissions.

**Experience.** Calm, legible, friendly, responsive, accessible, light/dark; subtle purple/blue atmospheric color **only in the page background**, not on buttons/cards/controls. The dashboard is useful without external services; Ora's identity remains consistent.

**Status and interpretation.** This file is the approved **product-level specification**, not a code architecture or a claim that features have been built. The source includes many detailed decisions from October 2026. Some provider details, the original three-phase inventory, and some implementation specifics are still undocumented. Treat those as gaps; do not invent answers.

### Documentation map — read in this order

| File | Purpose | When to read |
|---|---|---|
| `Project-entry.md` | Product introduction, MVP inventory, terminology, principles, workflows, gaps and AI instructions | **Always read first** |
| `Modules.md` | Functional module catalogue (`Modules.md` §4.1–4.9), module boundaries and MVP coverage | Before scoping or building a module |
| `Project-specification.md` | **Binding detailed requirements**: global rules, Ora, identity, Homes, permissions, workflows, confirmed decisions, visual guidelines and open questions | Read the relevant sections before implementation; this file governs over summaries |

Do not infer that a module is fully specified merely because it appears in the catalogue. Many approved feature-specific decisions are in `Project-specification.md`, especially under `Project-specification.md` §11.2 and its subsequent subsections.

### MVP module inventory — implementation planning baseline

The following inventory makes the **documented product modules and cross-cutting MVP foundations** easy to find. **All three previously approved phases are included in the MVP**; the original exact phase-by-phase list is missing from the accessible source. Consequently, the entries marked **catalogued** are in the product's functional module catalogue and must be reconciled against that original phase list before using this table as an exhaustive contractual checklist. Do not interpret this caveat as permission to drop any agreed capability.

| ID | Module / capability | Core MVP behavior | Evidence / commitment |
|---|---|---|---|
| M01 | **Dashboard & widgets** | Personal/Home dashboards; edit, add, remove, arrange and configure widgets; reusable templates; permission-safe cross-Home widgets | Catalogued `Modules.md` §4.1; journeys `Project-specification.md` §9 |
| M02 | **Calendar & scheduling** | Native events; personal/Home visibility; Google Calendar inbound sync and outbound event creation/editing, with conflicts reviewed | **Explicit MVP commitment** `Modules.md` §4.2, `Project-specification.md` §10 |
| M03 | **Tasks & chores** | Personal and Home tasks, assignments, completion, shared chore tracking and widgets | Catalogued `Modules.md` §4.3; journeys `Project-specification.md` §9 |
| M04 | **Shopping lists** | Multiple personal/Home lists, item quantities, categories, completion, quick entry, widgets and meal-to-shopping transfer | Catalogued `Modules.md` §4.4; detailed decisions `Project-specification.md` `Project-specification.md` §11.2+ |
| M05 | **Recipes** | Recipe library, creation/editing, imports with review, sharing, discovery, cooking mode and relevant widgets | Catalogued `Modules.md` §4.4; detailed decisions `Project-specification.md` `Project-specification.md` §11.2+ |
| M06 | **Meal planner** | Day/week plans, configurable slots, recipe/custom meals, repeat/copy, print view, shopping transfer and widgets | Catalogued `Modules.md` §4.4; detailed decisions `Project-specification.md` `Project-specification.md` §11.2+ |
| M07 | **Habits & routines** | Personal/shared habits, flexible schedules, daily check-ins, numeric targets, reminders, corrections, widgets | Catalogued `Modules.md` §4.5; detailed decisions `Project-specification.md` `Project-specification.md` §11.2+ |
| M08 | **Goals** | Personal and collaborative goals, measurable/completion goals, recurring periods, progress, habit links and widgets | Catalogued `Modules.md` §4.5; detailed decisions `Project-specification.md` `Project-specification.md` §11.2+ |
| M09 | **Rewards & points** | Personal/Home points and rewards, optional leaderboard and associated widgets; scoring specifics need supporting spec | **Explicit MVP commitment** `Modules.md` §4.5, `Project-specification.md` §10 |
| M10 | **Pets** | Home-owned profiles, care/medical information and schedules, plus **separate pet-task widget** | **Explicit MVP commitment** `Modules.md` §4.6, `Project-specification.md` §10 |
| M11 | **Photos** | Personal/Home libraries, albums, cross-Home sharing, optimized storage, widgets/slideshows, permission-aware deletion/recovery | Catalogued `Modules.md` §4.7 |
| M12 | **Ora assistant** | Context- and permission-aware summaries/planning; editable proposals, explicit confirmation, recoverable actions | Core product capability `Project-specification.md` §5; journeys `Project-specification.md` §9 |
| M13 | **Household Display** | Dedicated paired Home display, Home-controlled privacy, layout and member actions | Catalogued `Modules.md` §4.9; detailed `Project-specification.md` §6 |
| M14 | **Integrations** | **Google Calendar required**; authorization, disconnect and sync/error handling. Other providers not assumed | Google explicitly committed `Modules.md` §4.8, `Project-specification.md` §10 |
| F01 | **Accounts & profiles** | Sign-in/recovery, personal settings, security, devices, notifications, exports, deletion, per-Home profile presentation | Cross-cutting foundation `Project-specification.md` §6 |
| F02 | **Homes, roles & invitations** | Multiple Homes, Owner/Admin/Member permissions, invites, membership, child/guardian and shared-device safeguards | Cross-cutting foundation `Project-specification.md` §6 |
| F03 | **Notifications & reminders** | Authorized reminders and security alerts, preference controls, cross-module delivery/error behavior | Cross-cutting foundation `Project-specification.md` §6 and module details |
| F04 | **Privacy, ownership & data lifecycle** | Personal/Home separation, authorization, sharing, history, exports, deletion, recovery and audit safeguards | Cross-cutting foundation `Project-specification.md` §6, `Project-specification.md` §8, `Project-specification.md` §10 |

**Explicitly excluded from MVP:** bill management, package tracking, and smart-home control (`Project-specification.md` §10). **Do not assume Spotify, weather provider integration, or any other third-party connector is committed to MVP** unless the missing original phase plan or a later explicit approval confirms it. Weather may appear as a conditional widget concept, not a committed external integration.

### Essential product mental model

1. **Account / identity:** One underlying identity per person. Adults can use Madeora without belonging to a Home; eligible children have additional guardian-managed rules. Account credentials, recovery, personal settings, and security are private.
2. **Personal context:** Data belonging to an individual. It is **not** automatically shared with their Homes. A person's global dashboard may show expressly authorized selected Home widgets.
3. **Home:** Shared household container with its own members, roles, data, permissions, appearance, scheduling timezone and displays. An adult can belong to multiple Homes and explicitly switch context.
4. **Ownership vs presentation:** A person's identity is global, but their name/avatar may vary by Home. A record has an authoritative owner/context; displaying or sharing it elsewhere does not silently transfer ownership or create duplicate canonical data.
5. **Modules vs widgets:** Modules own complete feature workflows. Widgets are compact views/actions into modules, not separate data stores or competing permission systems.
6. **Household Display:** A separately paired, Home-scoped identity with strict shared-screen rules. It is not a trusted personal device and cannot inherit a member's unrestricted private access.
7. **Ora:** Uses only authorized data; drafts proposals for user review, never silently applies consequential changes. All module-level constraints continue to apply to Ora.
8. **Personal language/region/timezone:** Personal interface language, regional formats and device-detected timezone with override are independent; Home scheduling and Household Display settings remain Home-scoped. User-created text is not automatically translated.

### Non-negotiable product rules

- **Privacy first:** No searchable user directory. Invitations require authorized email/link/code mechanisms; no account enumeration. Unshared calendar events reveal **nothing**, including busy times.
- **Explicit Home context:** Show the active context and the scope/visibility of actions; never infer sharing from mere membership or connected accounts.
- **Authorization at every surface:** UI, widgets, APIs, notifications, Ora, exports and Household Displays must enforce the same underlying permissions. Permissions are rechecked when an action executes.
- **Safe edits:** Sensitive/destructive actions use review/confirmation and recovery rules; concurrent changes and revoked permissions must not produce silent data loss.
- **Honest integrations:** Native data works without providers. Sync states distinguish success, pending, conflict, stale and failure. Google Calendar conflicts require human resolution, not last-write-wins.
- **Accessible, responsive, complete:** Every MVP feature needs normal/empty/loading/error/denied/offline-relevant states, keyboard/screen-reader support, and testable end-to-end behavior. No mock flows count as shipped.
- **Decisions outrank guesses:** Global product/privacy rules take precedence over local details; genuine consequential contradictions are flagged for explicit user approval, not silently resolved.

### First implementation journeys (dependency-aware)

| Journey | Expected end-to-end result |
|---|---|
| New adult | Register/sign in → usable starter personal dashboard → customize widgets → settings persist |
| Join Home | Receive private invitation → authenticate → approved membership → effective permissions and Home context are clear |
| Shared chore | Authorized member creates/assigns task → another member completes → widgets and permitted histories update |
| Plan dinner | Save/select recipe → plan meal → transfer selected ingredients → check off shopping items |
| Google Calendar | Connect account → select calendars and visibility → import/sync → create/edit from Madeora → resolve conflicts safely |
| Habit to goal | Check in a personal/shared habit → linked measurable goal updates according to approved rules → correction recalculates safely |
| Pet care | Authorized Home member creates pet → adds care schedule → dedicated pet-task widget displays actionable item |
| Ora change | Ask Ora for help → review editable proposed action → confirm → apply with permissions → recover when supported |
| Shared screen | Pair Household Display with manager approval → show Home-authorized data → prevent private leakage |
| Privacy lifecycle | Review settings/history → export permitted data → revoke device/share or delete data with required confirmation/recovery |

### Claude / developer operating instructions

- **Read this orientation first, then the relevant detailed section.** Do not rely on this summary instead of the full requirements; the detailed decisions remain binding.
- Before coding a feature, extract its **actors, context/ownership, permissions, workflow, state transitions, validation, edge cases, cross-module dependencies, failure behavior, and acceptance tests** from the relevant detailed sections. Create a supporting feature specification if missing.
- Distinguish **approved requirement**, **suggested visual/implementation default**, **open decision**, and **inference** in plans and code reviews. Do not promote an inference into a product decision.
- Never invent technology choices, pricing, release dates, provider capabilities, original phase assignments, or unapproved sharing policies. Keep architecture decisions in a separate document.
- Preserve existing requirements when making edits. Record what changed, why, which sections are affected, and whether the user approved it. If an edit conflicts with a prior approval, flag it and request a decision.
- Work **dependency first**: account identity → Home/roles/ownership → permissions → core module data/workflows → widgets/cross-module actions → integrations/Ora/display → comprehensive acceptance tests.
- A feature is not done because a screen renders: complete persistence, authorization, state/error handling, responsive/accessibility behavior, and cross-module tests are required.

### Documentation gaps / ambiguity register (do not silently resolve)

| Item | Current status | Required follow-up |
|---|---|---|
| Original MVP phases | All three phases **approved as MVP**, but exact item-by-item original plan absent | Recover original phase list and reconcile each item to this module inventory; do not reduce scope in the meantime |
| Spotify and other integrations | Mentioned, not explicitly committed at provider/action level | Verify original scope and approve provider-specific behaviors |
| Technology architecture | Explicitly outside this product spec | Separate technical decision record |
| Some provider error/conflict details | High-level constraints approved, details incomplete | Supporting integration spec with failure/retry/recovery acceptance tests |
| Module-level scoring and permission matrices | Direction approved, some exact rules still need specification | Supporting Rewards, roles and feature permission specs |
| Detailed delivery schedule, pricing and release milestones | Not approved here | Separate product/business decisions |
| Settings synchronization across devices | Previously presented as next choice, **not approved** | Decide separately; do not assume option C |

---

