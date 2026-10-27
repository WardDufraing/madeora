# ADR 0031: Recipes core

- **Status:** Accepted for S24 within the approved architecture (§4, §9, §10, §36, §37), CLAUDE.md (database access A, authorization C, data fetching B, forms A, file storage B, dashboard layout B, €0 budget) and the spec's recipe sections (PS L2584–L2721). The defaults below are open to correction by the owner.
- **Date:** 2026-10-27
- **Step:** S24 (brief: `plans/steps/S24-brief.md`). Builds on ADR 0019 (file storage), 0020 (trash), 0021 (dashboards) and 0025 (attachment finalize dispatch).

## Context

People keep recipes in their Personal space or a Home. The spec asks for private drafts, a single latest version of each recipe, exclusive editing, ratings, favorites, search and tags, serving scaling, cooking mode, one cover photo and recipe widgets. A draft must never leak to the Home it is meant for, and two people must never overwrite each other's edits.

## Decision

**One migration, no exposed tables.** `20261106090000_recipes.sql` adds `private.recipes`, `recipe_ingredients`, `recipe_steps`, `recipe_edit_locks`, `recipe_favorites`, `recipe_ratings` and `recipe_cover_uploads`, the delegable capability `manageHomeRecipes`, the trash type `recipe` and the file purpose `recipe_cover`. Every read and change is a `security definer` function run with the person's session.

**Draft privacy by ownership.** A draft is always owned by its creator's Personal space; its intended Home is a separate column (`draft_home_id`). No Home read can therefore return a draft, whatever the filter. Publishing moves ownership to the destination in one transaction, after rechecking membership, the published minimum (a visible name and at least one ingredient or step) and a client publish id, so a retry answers `already_published`. Publishing to a Home moves the draft's cover to the Home's storage pool, quota-checked. When the creator leaves the intended Home, the destination is cleared and flagged.

**Latest only.** Saving replaces the content; `revision` is only a concurrency token. There is no history and audit stores ids and actions, never content.

**Exclusive lock.** One row per recipe in `recipe_edit_locks`, taken by an `insert … on conflict … do update where expired or mine`, so two simultaneous attempts cannot both win. It lasts 2 minutes after the last heartbeat (sent every 30 s); the editor warns after 13 minutes without input and stops heartbeating at 15. Saving rechecks, in one transaction, the lock token, its expiry, the right to edit and the revision; any failure changes nothing. Leaving or removal ends a person's locks in that Home. Nobody can force another person's lock; the same account may take over its own lock from another tab. Drafts take no lock (only their creator can open them) and rely on the revision.

**Rights (defaults picked).** Every current member views, searches, favorites, rates and publishes into the Home; the creator (while a member) and holders of `manageHomeRecipes` (the Owner always, Administrators when granted) edit and delete. Drafts belong to their creator only. Restore from trash follows the S16 rule. The matrix is mirrored in `@madeora/domain` (`permissions/recipes.ts`) for the interface only.

**Ratings and favorites.** 1–5 stars per member and recipe, published recipes only; the average and count are over current members of the recipe's context, and individual ratings are never shown. Favorites are per member and per context, ready for S25's sharing.

**Quantities and scaling.** Exact fractions with the way they were typed; scaling is a view (`?servings=N`) with exact arithmetic in `packages/domain/src/recipes`, rounded display marked "≈" with the exact value on request.

**Cover photo.** One per recipe, JPEG/PNG/WebP up to 10 MB, re-encoded server-side to WebP of at most 1600 px without metadata through the S15 pipeline. The finalize route dispatches the `recipe_cover` purpose to `src/recipes/cover-image.ts`; the cover is applied only by the next save, and unused uploads are retired by the existing expiry job.

**Interface and API.** Library, new, drafts, detail, edit and cooking pages under `/recipes` and `/homes/:id/recipes`; the sidebar's Meals opens Recipes for the open context. Route Handlers under `/api/v1/recipes` with the same CSRF, JSON, size, session and outcome mapping as earlier steps. A **Recipes** dashboard widget (favorites, recent, highest rated or random; 1, 3 or 5 cards, random 1). No notifications and no Realtime: pages refresh after one's own changes and cooking mode checks every 60 s.

**Generated bindings.** `recipe_widget` and `set_recipe_rating` give every parameter a SQL default (null), so the generated types let the Personal widget omit the Home and clearing a rating omit the stars.

## Consequences

- Draft privacy holds by construction; a future Home read cannot leak drafts by forgetting a filter.
- An abandoned edit frees itself within 2 minutes; a lapsed edit keeps its text on the page and never overwrites newer content.
- Sharing between contexts, URL import and impact-reviewed deletion of shared recipes (S25), meal planning (S26, S27), Ora actions (S45) and wall displays (S43–S44) are later steps. There is no Owner lock-recovery action.
- The migration is forward-only like every other; repairing it on production means a new migration.
