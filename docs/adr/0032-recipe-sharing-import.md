# ADR 0032: Recipe sharing and URL import

- **Status:** Accepted for S25 within the approved architecture (§4, §9, §10, §38), CLAUDE.md (database access A, authorization C, data fetching B, forms A, €0 budget) and the spec's recipe sections (PS L2567, L2576, L2607–L2623, L2647–L2653). The defaults below are open to correction by the owner.
- **Date:** 2026-10-27
- **Step:** S25 (brief: `plans/steps/S25-brief.md`). Builds on ADR 0031 (recipes core) and 0020 (trash).

## Context

A recipe belongs to one Personal space or Home (S24). The spec asks for explicitly synchronized sharing between contexts (one recipe, never a copy), deletion of a shared recipe only after its impact is reviewed, per-context ratings, and importing a recipe from a web page into an editable preview that is saved only after the person confirms. Fetching a URL the person typed is a server-side request forgery risk.

## Decision

**One migration, no exposed tables.** `20261107090000_recipe_sharing_import.sql` adds `private.recipe_shares` (recipe, destination Home, `can_edit`, shared by/at, `suspended_at`), `private.recipe_import_attempts` and the columns `recipes.source_url` / `source_name`. Every read and change is still a `security definer` function run with the person's session; RLS is enabled and nothing is granted on the tables.

**Shares, not copies.** A share makes the canonical recipe visible in the destination Home's library, search, tags, widget and detail for that Home's current members. The visibility helpers (`can_see_recipe`, `recipe_visible_in`) and the edit helper (`can_edit_recipe`) include active shares, so every existing read picks them up. Reads take a viewing context (`p_home_id`, null meaning where the recipe lives).

**Who does what (defaults picked).** Only recipe managers of the origin (the Personal owner; a Home's Owner and Administrators with `manageHomeRecipes`) share, and only into Homes they belong to now; the creator alone cannot. Per destination the share is view only (default) or lets that Home's recipe managers edit content and cover under the same single lock; destination editors never delete, share or change shares. A destination's recipe managers may remove their own Home's share. Removing a share deletes that Home's favorites of the recipe and ends locks of people who can no longer edit. The matrix is mirrored in `@madeora/domain` (`permissions/recipes.ts`) for the interface only.

**Privacy in a destination.** The page says "Shared with this Home" and never names the origin, its members or other destinations; `homeId`, creator and updater members are withheld (only "you" is shown). The lock names its holder only to members of the viewing context, otherwise "someone else". Only origin managers can list the destinations.

**Ratings and favorites per viewing context.** The average and count are over current members of the context the recipe is seen from (spec L2652); favorites were already keyed by context in S24.

**Impact-reviewed deletion.** `recipe_delete_impact` answers the destinations, the number of favorites, whether someone is editing, and a token (md5 of the revision and the active shares). Deleting a shared recipe needs an origin recipe manager and that token: without it `impact_review_required`, with an outdated one `stale_impact`, and the dialog reloads the review. Someone else editing still refuses the delete. Deleting pauses the shares (`suspended_at`) and audits each destination; after a restore they stay paused until an origin manager reinstates (rechecked like a new share) or removes them. Nothing regains access silently. Meal-plan impact is added by S27.

**Lock order.** Home/membership key-share, then the recipe row, then lock and share rows, then storage pools; the concurrency tests race double shares, a save against leaving, and a delete against a share change.

**URL import.** `POST /api/v1/recipes/import` checks the destination, takes one of 20 hourly slots (`begin_recipe_import`), fetches the page server-side and answers a preview with likely duplicates (same source URL or name, among recipes visible in the destination and one's own drafts). Nothing is stored; the person saves through the ordinary editor with the S24 audience confirmation, and the source URL and attribution are set once at creation.

**SSRF protection (`apps/web/src/recipes/import/`).** http/https on ports 80/443 only, no user info, a fresh connection per request (no keep-alive pool), at most 2000 characters. The host is resolved once and **every** address must be public (`address.ts`: IPv4 special-purpose ranges and IPv6 loopback, mapped/compatible/translated, NAT64, 6to4, Teredo, documentation, unique-local, link-local, site-local, multicast; anything not an IP literal is refused). The connection is pinned to the checked address through a custom `lookup`, so there is no second DNS lookup to rebind. Redirects are followed by hand, at most 3, each re-checked with the same rules. 10 s overall, 2 MB after decompression, HTML/XHTML/JSON-LD content types only, no cookies, credentials or Referer, a plain Madeora User-Agent. Failures answer a reason (`invalid_url`, `blocked`, `unreachable`, `timeout`, `too_large`, `not_html`, `restricted`, `not_found`, `no_recipe`) and the page offers manual entry. Logs carry the reason only, never the URL.

**Extraction.** The page is read without regular expressions over its markup (`markup.ts`: `indexOf` scanning, bounded tag windows), so a hostile page costs time linear in its size; tests time 2 MB adversarial pages. schema.org `Recipe` JSON-LD only (arrays, `@graph`, `mainEntity`, `HowToSection`). All text is stripped of markup and entities, control characters are dropped and fields are cut to the S24 limits, with warnings. Ingredient lines are read into quantity, unit and name only when clear; ranges, thousands-ambiguous numbers and unreadable amounts are kept as written and flagged. Nothing missing is invented; photos are never copied; robots.txt is not consulted (one page the person asked for, like a browser visit).

**Interface and API.** Share panel at `…/recipes/:id/share`; import at `/recipes/import` and `/homes/:id/recipes/import`; "Remove from this Home" on a shared recipe for the destination's recipe managers; the delete dialog shows the impact and links to the share panel. Routes: `GET|PUT|DELETE /api/v1/recipes/:id/shares` (PUT also reinstates a paused share), `GET /api/v1/recipes/:id/delete-impact`, `DELETE /api/v1/recipes/:id` with `impactToken`, `POST /api/v1/recipes/import` (Node runtime); detail, rating, favorite and lock take the viewing context. Same CSRF, JSON, size, session and outcome mapping as S24. No new provider, dependency or background job.

## Consequences

- Every recipe read already covers shared recipes; a new read must use `recipe_visible_in` / `can_see_recipe` to stay consistent.
- An import can only reach public addresses, and a host that answers even one private address is refused, which can block a few misconfigured public sites.
- Microdata, PDF, image or text import, copying photos, notifications about shares and meal-plan impact are out of scope (S26, S27, S45).
- Leaving a Home a recipe is shared into ends one's locks on it there, even for someone who can still edit it from the origin; their unsaved text stays on the page (S24) and they take the lock again.
- Origin recipe managers see the names of the Homes a recipe is shared with, including Homes they are not in (brief default 1); destination audit rows store the acting account, which a future audit view must show as "someone outside this Home".
- Context reads select shared recipes through `recipe_shares_home_idx` (an `= any (array(…))` initplan), so a library read stays index-driven.
- The import must not run behind an environment proxy (`NODE_USE_ENV_PROXY`), which would bypass the address pinning.
- The migration is forward-only like every other; repairing it on production means a new migration.
