# S12 · Role management and ownership — feature brief

**Branch:** `feat/roles-and-ownership`, from `main` at `a658322` (S11 merged, PR #18).
**Sources:** build plan S12 and its "Done when"; PS L276–L300 (ownership transfer, exactly one Owner, verified ownership recovery), L391–L424 (customizable Administrator permissions, member-removal authority, removal reaffirmation, privacy-minimized history after departure), L754–L769 (voluntary departure, guided transfer-or-close); ARCH §4; CLAUDE.md authorization strategy C, forms A, frontend B; ADR 0011 (engine), 0012 (invitations), 0013 (directory). Carry-overs: ADR 0011 "Administrators get no capabilities until S12"; S10 `manageInvitations` granted from S12; S11 "no member detail page until S12".

## Actors and powers

| Action                                                       | Owner                            | Administrator                | Member   |
| ------------------------------------------------------------ | -------------------------------- | ---------------------------- | -------- |
| Make a Member an Administrator, or an Administrator a Member | yes                              | never (Owner-only power)     | no       |
| Grant or revoke an Administrator's capabilities              | yes                              | never                        | no       |
| Remove a Member                                              | yes                              | only with **Remove members** | no       |
| Remove an Administrator                                      | yes                              | never                        | no       |
| Remove the Owner                                             | nobody                           | nobody                       | nobody   |
| Leave the Home                                               | only after an accepted transfer  | any time                     | any time |
| Start or cancel an ownership transfer                        | yes, to an existing adult member | no                           | no       |
| Accept or decline a transfer                                 | the nominated member only        |                              |          |

**Delegable capabilities** (Administrator only, each granted one by one by the Owner; a new Administrator starts with **none**, the least-privilege default):

- **Manage Home settings** (`manageHomeSettings`): Home name and scheduling timezone (exists since S09).
- **Manage invitations** (`manageInvitations`): Member invitations, links, join codes and Member join requests (S10). Inviting or admitting Administrators stays Owner-only.
- **Remove members** (`removeMembers`): remove ordinary Members, never Administrators or the Owner.
  No capability reaches an Owner-only power. No capability exists for modules that are not built yet (each module adds its own when it ships). There are no dependencies between these three today, so there are no invalid combinations to reject.

## Design

1. **Database** (one migration, `20261019090000_roles_and_ownership.sql`):
   - `private.home_admin_capabilities` (Home, account, capability, granted by, granted at), foreign key to the membership with `on delete cascade`. A trigger refuses a grant to anyone who is not an Administrator, and another deletes all grants when a role changes away from Administrator, whatever path changed it.
   - `private.has_home_capability(home, user, capability)`: the one SQL rule (Owner always; Administrator only with the grant). `homes_update_owner` RLS becomes "Owner or Administrator with Manage Home settings"; `private.can_manage_invitations` grants Member-role invitation management to Administrators with Manage invitations (Administrator roles stay Owner-only). Invitations created by an Administrator stop working at once when that grant is revoked (S10's `invitation_state` already re-checks the inviter).
   - `private.home_ownership_transfers` (Home, from, to, status `pending` / `accepted` / `declined` / `cancelled` / `expired` / `invalid`, created, expires after **7 days**, decided at, request id for double-submit safety). At most one pending transfer per Home (partial unique index).
   - Functions, `security definer`, empty `search_path`, execute for `authenticated` only, each re-checking the caller's confirmed account, current membership and authority, and taking a row lock on the Home first so every membership change in a Home is serialised (one lock order, no deadlocks): `home_capabilities`, `change_home_member_role`, `set_administrator_capabilities`, `remove_home_member`, `leave_home`, `start_ownership_transfer`, `respond_to_ownership_transfer` (accept/decline), `cancel_ownership_transfer`, `home_ownership_transfer`.
   - **Stale-confirmation safety:** role change, capability change and removal take the target's role as the caller saw it (`expected_role`); if it changed meanwhile the answer is `stale` and nothing happens (spec: fail safely and refresh).
   - **Transfer acceptance** re-checks that the sender is still Owner, the recipient still a member and the transfer still pending and unexpired, then demotes the former Owner to **Member** and promotes the recipient in one transaction. The S09 unique index allows at most one Owner and the deferred trigger at least one, so no committed state has zero or two. The recipient's Administrator grants are dropped. Removal or departure of the nominated member, or the sender ceasing to be Owner, makes a pending transfer `invalid` (a recipient's change between Member and Administrator does not).
   - **Audit:** membership ends record `removed` or `left`; role changes, capability changes (previous and new sets) and every transfer transition are recorded with ids only, never names or emails.
   - **Privacy after departure:** when a membership ends, all that person's join requests in that Home (any state) and the email invitation they accepted (which hold their email and name snapshot, shown to managers for 30 days) are deleted; the Home profile already goes with the membership (S11). The audit log keeps the id-only record. No module history exists yet; the ADR records the rule later modules follow (attribute by membership id, show "Former member" with no live profile link).
   - No direct API writes to memberships or grants, as before; RLS unchanged otherwise.
2. **Engine** (`packages/domain`): capability `removeMembers`; actions `home.members.manageRoles`, `home.members.manageCapabilities` (Owner only), `home.members.remove` (Owner, delegated through `removeMembers`), `home.leave` (Administrator, Member), `home.ownership.transfer` (Owner); and a target-aware `decideMemberAction(actor, target, action)` that applies the target rules (nobody touches the Owner; Administrators only touch Members; you never remove yourself, you leave). `getHomeContext` loads the caller's real grants.
3. **API** (`/api/v1`, same CSRF, JSON, size, verified-identity and engine checks as S09/S10; the database decides again):
   - `PATCH /homes/{homeId}/members/{membershipId}` `{ role, expectedRole }`
   - `PUT /homes/{homeId}/members/{membershipId}/capabilities` `{ capabilities }` (the database refuses it unless the target is an Administrator at that moment, so a stale role cannot grant anything)
   - `POST /homes/{homeId}/members/{membershipId}/remove` `{ expectedRole }`
   - `POST /homes/{homeId}/leave`
   - `POST /homes/{homeId}/ownership-transfers` `{ membershipId, requestId }`
   - `POST /homes/{homeId}/ownership-transfers/{transferId}/{accept|decline|cancel}`
4. **Pages:**
   - **Directory:** a member's row links to their page when the viewer can do something to them.
   - **Member page** `/homes/{homeId}/members/{membershipId}`: name, role, joined. Owner: role (Member / Administrator, with a confirmation), Administrator permissions editor (each capability with what it allows and what changes, a preview of added and removed rights, confirmation before saving), "Make Owner" (starts a transfer), Remove. Administrator with Remove members, on a Member: Remove. Removal confirmation names the person and Home and explains the loss of access, their Home profile, pending invitations they created becoming invalid, and that Home-owned content stays.
   - **My profile** gains "Your role and permissions" (read-only effective permissions) and "Leave this Home".
   - **Leave** `/homes/{homeId}/leave`: Members and Administrators confirm and leave. The Owner gets the guided **transfer or close** page: eligible members to choose a successor, the pending transfer with Cancel, and the close path explained but not yet available (Home deletion with its 30-day recovery is S40).
   - **Home dashboard banner:** the nominated member sees the request with Accept (confirmation explaining Owner responsibility) and Decline; the Owner sees "waiting for … to accept" with Cancel, and a declined, expired or invalid outcome until the next transfer.
5. **Immediate loss of access:** every page and API reads membership from the database on each request (S09), so a removed person's next request already fails; there are no Realtime subscriptions yet. A removed person who is still on a Home page is sent to their Personal space on the next navigation, and the remembered-context cookie is ignored because it is always re-checked.

## Tests

- **Unit:** engine matrix (every role × action × target role × self) and grants; Zod schemas; every route (CSRF, content type, size, unauthenticated, invalid, not found, not permitted, changed, each outcome); components with axe in both languages.
- **Database** (`tests/db/rls/roles-and-ownership.test.sql`): capabilities unreachable through the API; only the Owner changes roles and grants; grants only for Administrators, dropped on demotion; Admin with Manage Home settings can rename, without cannot; Admin with Manage invitations manages Member invitations but never Administrator ones, and loses them at once on revoke; removal matrix (Owner removes both; Admin with Remove members removes Members only; Admin without, Member, outsider refused; nobody removes the Owner; self-removal refused); stale `expected_role` refused; repeat removal reported as already removed; removed person reads nothing of the Home at once; leave for Member/Admin, refused for the Owner with or without a pending transfer; transfer to non-member, self, or outsider refused; one pending per Home; decline, cancel, expiry, recipient removed or left before acceptance all leave the Owner unchanged; acceptance leaves exactly one Owner; only the recipient can accept; audit rows without names or emails; join-request and invitation snapshots of a departed member are gone. A two-connection test: simultaneous acceptance and removal, and two acceptances, never leave zero or two Owners.
- **Playwright:** Owner promotes a Member to Administrator, grants Remove members; that Administrator removes a Member and has no Remove control for another Administrator; the removed Member's next page load has no access to the Home and the Home is gone from the switcher; a Member leaves; Owner starts a transfer, the recipient declines (Owner unchanged), Owner starts again, recipient accepts, roles swap, the former Owner can then leave; the Owner's leave page offers only transfer. Keyboard-only and axe in both themes on the new pages.

## Out of scope (later steps)

- **Verified ownership recovery** (PS L293–L300): needs Madeora-side review of identity evidence, a waiting and objection period with notifications, disputes and appeals; see the decision for Ward below.
- **Close Home** (deletion with 30-day recovery): S40. The Owner's leave page explains it.
- **Notifications** to removed members, affected Administrators and transfer recipients: S14. Until then states show in the app (dashboard banner, transfer status).
- Unassignment of tasks, personal shares, Household Displays, children and guardians: their own steps; each must hook into membership end.
- The shared Home theme (S11 out of scope) and capabilities for modules that do not exist yet.

## Defaults picked (owner may override)

1. A new Administrator starts with no capabilities (least privilege); the Owner grants them on the member page.
2. Three capabilities only: Manage Home settings, Manage invitations, Remove members.
3. After an accepted transfer, the former Owner becomes a **Member** (the new Owner can promote them).
4. A pending ownership transfer expires after **7 days** (the spec leaves expiry open).
5. Pending transfers are visible only to the Owner and the nominated member.
6. Departure deletes all the departed member's join requests and the accepted email invitation in that Home (they hold email and name snapshots); the audit log keeps id-only records.
7. Granting capabilities and changing roles need a confirmation step; revoking a capability needs one too, because it can end the Administrator's access to a page they are using.

## Decision for Ward

- **Verified ownership recovery.** Recommended: move it to its own later step after notifications (S14) and file storage (S15), because it needs a Madeora-side reviewer (you), an evidence process, waiting period and owner notifications that do not exist yet. Until then an Owner who loses their account uses normal account recovery, and the Home keeps its Owner.

## Acceptance tests (done when)

1. RLS and E2E tests show removed members lose access at once.
2. There is always exactly one Owner, including under concurrent transfer and removal.
3. Administrator limits hold at the database.
4. Format, lint, typecheck, unit tests, build, database tests and E2E pass.
