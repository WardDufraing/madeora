# S09 · Homes, roles and the permission engine — feature brief

**Branch:** `feat/homes-and-roles`, from `main` at `bde1b81` (S07 and S08 merged).
**Sources:** build plan S09 and its "Done when"; PS "Confirmed multi-Home model" and "Confirmed Home-independent adult account onboarding" (L86–L100), "Confirmed explicit multi-Home switching" (L102–L109), "Confirmed Home roles" (L270–L274), "Confirmed exactly one Home Owner" (L284–L291), "Confirmed customizable Administrator permissions" (L391–L398, read for the engine's shape only; editing grants is S12), Home scheduling timezone (L632, L637), no translation of Home names (L615); ARCH §4 (domain model, authorization strategy C), §5 (hybrid API), §6 (DB), §9 (caches); CLAUDE.md authorization C, database A, forms A; S07 review round 3 M1 (stricter name policy deferred to S09/S11).

## Actors and permissions in this step

- **Any signed-in adult** (all accounts are adults until S41; displays arrive in S43) can create a Home and becomes its single **Owner**.
- **Owner:** sees the Home, changes its settings (name, scheduling timezone).
- **Administrator:** sees the Home. Delegated capabilities are granted by the Owner one by one (spec L392); granting arrives in S12, so in S09 an Administrator has none yet (least privilege). The engine already takes a set of granted capabilities, so S12 only has to store and load them.
- **Member:** sees the Home.
- **Anyone else** (no membership, a removed member, another Home's members, signed out): sees nothing, and cannot tell a Home they lost from one that never existed.
- Nobody can join, invite, change roles, remove members or delete Homes yet (S10, S12, S40). In tests, a second membership is created by a database fixture standing in for S10's invitations.

## Design

1. **Database** (one migration):
   - `public.homes`: id, name, scheduling `timezone` (IANA, same shape check as `user_preferences`), `created_by`, a creation request id for duplicate-submission safety, timestamps.
   - `public.home_memberships`: id, home_id, user_id, role (`owner` / `administrator` / `member`), created_at; one membership per person per Home; **at most one Owner per Home** (partial unique index) and **at least one Owner** checked at commit (deferred constraint trigger), so a Home is never ownerless. Deleting the account of a Home's only Owner is refused until S12/S40 bring transfer-or-close.
   - `private.audit_events` (not reachable through the API): who (stable account id), which Home, what action, which subject, when, with minimal details (changed field names, old and new role). Written by triggers on both tables, so every path is audited, including future RPCs and the service role.
   - **RLS:** a Home is readable only by its current members; a person reads only their own memberships (the member directory with other people's rows is S11). The only API writes are `public.create_home(name, timezone, request_id)` (security definer, atomic Home + Owner membership, returns the existing Home on a repeated request id) and updating `name`/`timezone` on `homes`, allowed by RLS only for that Home's Owner. No insert, update or delete on memberships through the API at all.
2. **Name policy (S07 M1):** Home names are the first names other people see, so the stricter policy lands here, in the app (Zod) and as a database check: NFC, trimmed of all Unicode whitespace, 1–50 characters, no control, format (zero-width, direction) or other invisible characters, except a zero-width joiner or variation selector directly attached to a visible character (emoji sequences) and complete emoji tag flags; at least one visible letter, digit, symbol or punctuation mark. Display names keep S07's rule until S11 makes them visible to other members; S11 switches them to the same policy.
3. **Permission engine** (`packages/domain`, pure TypeScript, server-safe, no secrets): typed roles, actions (`home.view`, `home.updateSettings`), delegable capabilities (`manageHomeSettings`), and `decideHomeAction(context, action)` returning allowed or a reason. Owner-only powers are a separate type that capabilities can never contain. A UI projection (`homePermissions`) only guides the interface. A policy-matrix unit test covers every role × action × grant combination, plus no membership and the wrong Home.
4. **Server side** (`apps/web/src/homes`): `listMyHomes()` and `getHomeContext(homeId)` read with the person's own session (RLS), validate the id, and return null for anything not visible. `POST /api/v1/homes` creates a Home; `PATCH /api/v1/homes/[homeId]` changes settings. Both: same-origin check (CSRF), JSON only, size limit, verified identity, Zod, then the engine, then the database with the person's session.
5. **Explicit Home context in the URL:** the Personal context stays at `/`; a Home lives at `/homes/[homeId]` (Home dashboard) and `/homes/[homeId]/settings`. Every Home page re-checks membership on the server. A Home id that is unknown, malformed or no longer yours leads to the personal dashboard with one neutral notice ("That Home isn't available to you"), identical in all cases. Two tabs can be in different Homes without affecting each other, and pending forms carry their Home id.
6. **Home switcher** in the top bar (desktop and phone): a disclosure button naming the current context (Personal or the Home's name), opening a list with Personal, each current Home with the person's role, and Create a Home. Only current memberships are listed. Names are isolated for right-to-left text and never translated.
7. **Remembering the last Home:** a device cookie records the last Home opened, tied to the account id. Opening `/` (for example right after sign-in) goes to that Home if the membership is still current; choosing Personal in the switcher clears it. A stale or foreign cookie is ignored.
8. **Create a Home** page (`/homes/new`): name and scheduling timezone (default: the person's effective timezone), React Hook Form + Zod, accessible errors, the button disabled while saving, and a request id so a double click or retry never makes two Homes. Leaving the page creates nothing. Success opens the new Home's dashboard.
9. **Home dashboard** (`/homes/[homeId]`): the Home's name, the person's role, an honest empty widget area (S17), a link to Home settings. No personal data appears here.
10. **Home settings** (`/homes/[homeId]/settings`): name and timezone, editable when the engine allows it, read-only with an explanation otherwise. The timezone field explains that Home schedules follow it, not anyone's personal timezone.
11. **Personal dashboard:** the "Create a Home / Join a Home" card stays while the person has no Home (S07); once they have one, the switcher carries Create a Home. Join stays a placeholder until S10.
12. **Caches:** Home pages are server-rendered with `no-store`; the client query cache is already reset per account; nothing Home-scoped is cached across Homes.

## Tests

- **Unit:** engine policy matrix; name policy (zero-width, direction marks, fillers, Braille blank, lone combining marks, emoji ZWJ sequences, flags, CJK/Arabic/accented names); Home schemas; API routes (CSRF, content type, size, unauthenticated, invalid, forbidden, not found, success); switcher, create form and settings form in both languages with axe.
- **Database / RLS** (`tests/db/rls/homes.test.sql`, two-user harness plus a third seeded user): create a Home and become Owner; a repeated request id returns the same Home; cross-Home reads and writes refused; forged ids (create in someone else's name, update another Home, insert a membership into another Home); role escalation (member or administrator making themselves Owner, inserting a second Owner, deleting the Owner); revoked membership loses access at once; anonymous sees nothing; audit rows written for each change and unreadable through the API; name policy and timezone checks hold for direct API writes; the Owner invariant holds at commit.
- **Playwright:** one adult creates Home A (Owner); a fixture adds them as Member of Home B owned by another account; they switch Personal → A → B → Personal in both directions, see different roles and settings rights, reload keeps the Home, the personal dashboard stays separate, a removed membership while viewing leads to the neutral notice, a foreign Home id gives the same notice; keyboard-only switching; axe on the new pages in both themes.

## Out of scope (later steps)

Invitations and joining (S10), member directory, nicknames, avatars, accents and Home theme (S11), Administrator grants, removal, departure, ownership transfer and recovery (S12), Home notifications (S14), Home dashboard widgets (S17), Home week start and other module settings (with their modules), Home deletion (S40), children and displays (S41–S44), correlation ids in audit rows (S13), audit retention (open in the spec).

## Defaults picked (owner may override)

- Home name: 1–50 characters, the stricter name policy above.
- Required at creation: name and scheduling timezone only.
- Administrators have no delegated capabilities until S12 lets the Owner grant them.
- Members see only their own membership row until S11's member directory.
- Opening Madeora returns to the last Home used on that device; choosing Personal makes Personal the default again.
- No limit on how many Homes one account can create (the spec sets none).
- Deleting the account of a Home's only Owner is refused until transfer-or-close exists.

## Acceptance tests (done when)

1. Policy-matrix unit tests plus RLS tests cover cross-Home reads and writes, forged ids, role escalation and revoked membership.
2. Playwright switches one adult between two Homes with different roles while Personal stays separate.
3. Format, lint, typecheck, unit tests, build, database tests and E2E pass.
