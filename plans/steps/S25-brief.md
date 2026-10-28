# S25 · Recipe import and sharing — feature brief

**Branch:** `feat/recipe-import-sharing`, from `main` at `cc9c964` (S24 merged as PR #40, the Next.js security fix as PR #41).
**Sources (read only these ranges):** build plan S25; PS L2567 (recipe URL import), L2576 (impact-reviewed deletion of shared recipes), L2607–L2623 (context-owned recipes and departure; synchronized cross-context sharing), L2647–L2653 for the rating rule in shared contexts; ARCH §38; ADR 0031 (S24).
**Model:** Opus (SSRF protection, cross-context visibility in every read, deletion impact and stale-review checks).
**Done when (build plan):** SSRF tests (private IPs, redirects) pass and imports save only after confirmation.

## What already exists (S24)

One canonical recipe row (`private.recipes`) owned by a person's Personal space or a Home; drafts always personal; exclusive lock; latest-only content; trash; per-context favorites (`context_home_id`), ratings, widget, cover photo. Everything goes through security-definer functions run with the person's session. Nothing about sharing or import.

## Sharing (spec "explicitly synchronized cross-context recipe sharing")

- **One canonical recipe**, never a copy. `private.recipe_shares` (recipe, destination Home, `can_edit`, shared by, shared at, `suspended_at`). A share makes the recipe appear in the destination Home's library, search, tags, widgets and detail pages, for that Home's current members.
- **Who shares (default):** recipe managers of the origin: the Personal space's owner, or in a Home the Owner and Administrators granted `manageHomeRecipes`. The creator alone cannot share. Destinations are Homes the sharer belongs to now (never the origin). Published recipes only.
- **Per destination:** "View only" (default) or "Recipe managers of that Home may also edit". Destination editors edit content and cover under the same single lock; they never delete, share or change shares (no onward sharing).
- **Removing a share:** origin managers, or that destination Home's recipe managers ("Remove from this Home"). Removing never deletes the recipe or other shares; it drops the destination's favorites of it and ends locks of people who can no longer edit.
- **Idempotent:** sharing to a Home already shared with answers `unchanged` (or `updated` when only the edit choice changed). A Home that is deleted takes its shares with it.
- **Privacy:** in a destination the page says "Shared with this Home" and never names the origin, its members or the other destinations. Who added or changed it is shown only as "you"; the editing lock names the editor only if they are a member of the viewing Home, otherwise "someone else". Only origin managers see the list of destinations.
- **Ratings and favorites are per viewing context** (spec L2652): the average and count are over current members of the context you are looking from; favorites stay context-local (S24 table already keyed by context).
- **Departure:** shares belong to the recipe, so a creator leaving changes nothing for destinations. Leaving a destination Home ends that person's locks on recipes shared into it.

## Impact-reviewed deletion (spec "impact-reviewed deletion of shared recipes")

- Deleting a recipe **that has shares** needs an origin recipe manager (a creator without manager rights gets `not_permitted` for a shared recipe) and an impact review first: origin, the destination Homes (names, to managers only), how many people favorited it, whether someone is editing it now. Meal-plan impact is added by S27 (no meal plans exist yet).
- The review returns an **impact token** (a hash of the revision and the active shares). Delete sends it back; a changed recipe or share list answers `stale_impact` and the dialog reloads the review. A shared recipe deleted without a token answers `impact_review_required`.
- Someone else editing it still refuses the delete (`locked`), as in S24: the active editor's work is never discarded.
- The dialog offers **Cancel**, **Remove from one Home** (opens the share panel) and **Delete everywhere**.
- **Trash:** the recipe and its cover go to the trash for 7 days as before; its shares are paused (`suspended_at`). After a restore they stay paused: origin managers see "Paused since it was deleted" in the share panel and choose **Reinstate** (rechecked like a new share) or **Remove**. Nothing regains access silently.
- A repeated delete of a recipe already in the trash answers `not_found` (nothing happens twice).

## URL import (spec "recipe URL import", ARCH §38)

- Pages `/recipes/import` and `/homes/:id/recipes/import`, linked from the library. Pick the destination first (Personal or a Home you belong to), paste an http(s) URL, **Get recipe**.
- `POST /api/v1/recipes/import` `{ url, homeId }` checks the destination (`get_recipe_context`), takes a rate-limit slot (`begin_recipe_import`, 20 per hour per account), fetches **server-side only** and answers a preview. Nothing is stored.
- **SSRF protection** (`src/recipes/import/fetch.ts`): http/https only, ports 80 and 443 only, no user info in the URL, host resolved once and **every** address checked against blocked ranges (loopback, private, link-local, CGNAT, multicast, reserved, documentation, benchmarking, IPv4-mapped/compatible IPv6, NAT64 of private IPv4, unique-local and site-local IPv6); the connection is pinned to the checked address (no second DNS lookup, so no rebinding). Redirects followed by hand, at most 3, each re-checked. 10 s overall timeout, 2 MB body cap, HTML (or JSON-LD) content types only, no cookies, no credentials, no Referer, a plain Madeora User-Agent.
- **Extraction:** schema.org `Recipe` JSON-LD only (including `@graph`, arrays, `HowToSection`), no microdata. Name, ingredients (quantity, unit and name read from each line where clear, otherwise the line kept as written and flagged), steps, yield → servings and label, prep and cook time (ISO 8601 durations), keywords/category/cuisine → tags, description → notes, author/publisher/site name → attribution. All text has tags and entities removed, control characters dropped and is cut to the field limits (cut fields are flagged). Never invents missing fields. Fetched text is data only.
- **Errors with a reason** and a link to enter the recipe by hand: invalid URL, blocked address, unreachable, timeout, too large, not a web page, sign-in or paywall (401/403/402), not found, no recipe data on the page, rate limited.
- **Review:** the preview shows the source link and attribution, warnings (missing fields, lines kept as written, cut text), possible duplicates in the destination (same source URL or same name, among recipes visible there and the person's own drafts) with links, and a note when the page lists a photo (**photos are not copied**; add your own cover). Below it the ordinary recipe editor, prefilled: correct, remove, reorder, add, then **Save draft** or **Publish** (with the S24 audience confirmation). Cancel leaves nothing saved. A retry of the same save returns the same recipe (client id).
- **Source on the recipe:** `source_url` and `source_name` columns, set once at creation (`content.source`), shown on the recipe page as "Source: {site}" with the link (`rel="noopener noreferrer nofollow"`). Later edits never change it; the source site changing never updates the recipe.

## API

- `GET /api/v1/recipes/:id/shares` (origin managers: shares and the Homes one can still share with), `PUT /api/v1/recipes/:id/shares` `{ homeId, canEdit }`, `DELETE /api/v1/recipes/:id/shares` `{ homeId }`. Reinstating a paused share is the same `PUT` (built that way: one set-to-state call, rechecked like a new share).
- `GET /api/v1/recipes/:id/delete-impact`; `DELETE /api/v1/recipes/:id` takes `{ impactToken }`.
- `POST /api/v1/recipes/import`.
- `GET /api/v1/recipes/:id`, rating and favorite take the viewing context (`homeId`).
- Same CSRF, JSON, size, session and outcome mapping as S24.

## Database changes (`20261107090000_recipe_sharing_import.sql`)

`recipe_shares`, `recipe_import_attempts`, `recipes.source_url/source_name`; `can_see_recipe` and `can_edit_recipe` include shares; new `can_delete_recipe`, `recipe_visible_in`; context-aware `get_recipe`, `set_recipe_rating`, `set_recipe_favorite`, `acquire_recipe_lock`, `list_recipes`, `list_recipe_tags`, `recipe_widget`; `delete_recipe` with the impact token; share functions; `recipe_delete_impact`; `find_recipe_duplicates`; `begin_recipe_import`; member-left trigger and trash restore updated.

## Tests

- **Database:** share permissions (origin manager, creator, plain member, destination manager, non-member, forged Home id), visibility in list/search/tags/widget/detail/cover for destination members only, view-only vs edit shares, lock across Homes and lock identity privacy, unshare removes access and favorites and locks, departure (creator leaves origin; member leaves destination), per-context ratings and favorites, impact review and stale token, delete permission for shared recipes, trash pause and reinstate, duplicate detection, import rate limit, source stored once.
- **Unit:** IP range checks (IPv4, IPv6, mapped forms), URL rules, fetch with redirects to private addresses, ports, timeouts, size cap, content type; JSON-LD extraction (graph, sections, durations, yields, hostile HTML, missing fields), ingredient line parsing; schemas; routes; components with axe.
- **Playwright:** share a Personal recipe with a Home and see it as another member; destination cannot delete; impact review lists the Home; import blocked-address error with manual fallback; import preview (mocked answer) → edit → publish shows the source.

## Out of scope

Meal-plan impact counts and unavailable-recipe states in meals (S27); shopping transfer (S26–S27); Ora actions (S45); notifications about shares; microdata or PDF/image/text import; copying photos from websites.

## Defaults picked (Ward may override)

1. Only origin recipe managers share (Personal owner; Home Owner and Administrators with `manageHomeRecipes`), and only into Homes they belong to.
2. Per destination: view only by default; optionally the destination's recipe managers may edit. Destination editors never delete or share.
3. A destination's recipe managers may remove their own Home's share.
4. Deleting a shared recipe needs an origin recipe manager and the impact review; shares are paused in the trash and must be reinstated by hand after a restore.
5. Import reads schema.org JSON-LD only; photos are never copied; robots.txt is not consulted (one page the person asked for, like a browser visit); ports 80/443 only; 3 redirects; 10 s; 2 MB; 20 imports per hour.
6. The source URL and attribution are kept on the recipe and cannot be edited.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests (`recipe-sharing.test.sql`, `recipe-sharing-concurrency.test.ts`)
- [x] API and data layer
- [x] Interface (share panel, import page, impact-reviewed delete, "Remove from this Home", source on the recipe)
- [x] Unit, route and component tests (SSRF: 41 fetch tests, 50 address cases; extraction; ingredient lines; axe)
- [x] Playwright (`recipe-sharing-import.spec.ts`)
- [x] Docs (ADR 0032, US-025, development.md, supabase-migrations.md S25 check, production-migrations.md)
- [x] Full suite (logs in `wip/S25/`)
- [x] Independent review (`reviews/steps/S25-review.md`): CHANGES_REQUIRED, 1 blocker, 0 high, 3 medium, 8 low. Fixed and verified myself (no second full review, per the project rules):
  - **B1 / M3 (slow regex on hostile pages):** the extractor no longer runs regular expressions over the page. New `src/recipes/import/markup.ts` finds tags with `indexOf`, reads attributes inside a 2000-character window and strips tags in one pass; `markup.test.ts` times ten 2 MB adversarial pages (all well under the 2 s bound; the reviewer measured 49 s for 66 KB before).
  - **M1 (scans of every Home's recipes):** the shared-recipe filter in `list_recipes`, `list_recipe_tags`, `recipe_widget` and `find_recipe_duplicates` is now `r.id = any (array(select … from recipe_shares …))`; `EXPLAIN` shows a BitmapOr over `recipes_home_idx` / `recipes_user_idx` and the primary key, with the shares read through `recipe_shares_home_idx`.
  - **M2 (Remove without confirmation):** removing a share and making an editable share view only now open a dialog naming the Home and what it loses; component tests and axe cover it.
  - **L2:** the reinstate button says "Turn back on (view only)". **L3:** a rate-limited import also offers manual entry; the brief's API line was already corrected. **L4:** `agent: false` (no pooled sockets); ADR notes the import must not run behind `NODE_USE_ENV_PROXY`. **L5:** decompression uses `stream.pipeline`, with a test that a cut-off page answers `unreachable` at once. **L7:** the source link shows the real host next to the credited name.
  - **Accepted and documented in ADR 0032:** L1 (leaving a destination ends one's lock there even with origin rights; text stays on the page), L6 (origin managers see destination names: brief default 1, Ward may restrict), L8 (destination audit rows keep the acting account; a future audit view must anonymise).
  - Reruns after the fixes: format, lint, typecheck, unit, boundary, spec guard green; DB suite 115/115; recipe E2E 6/6.
- [x] Commit and push (Ward's consent 2026-10-27): PR #42, `feat/recipe-import-sharing`. CI green on `f4e3010` after two follow-ups:
  - Secret scan flagged `const TOKEN = "<uuid>"` in the concurrency test (generic-api-key); renamed `EDIT_SESSION` and recorded the first commit's fingerprint in `.gitleaksignore`, as S24 did.
  - E2E: `task-reminders-templates-bulk.spec.ts:179` (S19b, untouched) failed once with a 400 on bulk complete; it fails intermittently locally too (once on this branch, passes on retry and on main). Commented on the PR and re-ran once: green. Worth a separate fix ticket.

### Notes from the build

- Ingredient lines: a number glued to text that is not a unit ("2x flour") is kept as written; "200g flour" is read as 200 g.
- Text cleaning drops `<script>`/`<style>` contents and joins inline formatting without adding spaces.
- The DB concurrency test now removes the trash-purge outbox rows its deletes queue, so the outbox tests see no leftovers.
- Local runs: the DB suite ran against a fresh throwaway cluster (initdb as a normal user); the E2E fallback needed the pre-installed Chromium mapped to Playwright 1.56's expected revision via `PLAYWRIGHT_BROWSERS_PATH`. No repository change for either.
- Full E2E: 169 of 170 passed; the one failure (`roles-and-ownership.spec.ts:64`, axe saw the page before its `<title>`) also failed in the S24 full run and passes when rerun alone (3/3). Unrelated to S25.
- Provider cost register: unchanged (no new provider; the import fetch runs on the app server).
