# S24 · Recipes core — feature brief

**Branch:** `feat/recipes-core`, from `main` at `6b128d8` (S23 merged as PR #39). Depends on S17 (dashboard) and S15 (file storage), both merged; also uses S16 (trash) and S12 (delegable capabilities).
**Sources (read only these ranges):** build plan S24; PS L2584–L2721 (private drafts and publishing, latest-only content, exclusive edit locks, context-owned recipes and departure, synchronized sharing (for the data model only; sharing itself is S25), recipe widgets, single cover photo, cooking mode, ratings, search/tags/favorites/sorting, serving scaling, structured fields; the meal-planner decisions in that range belong to S27); ARCH §4, §9, §10, §36, §37; ADR 0019, 0020, 0021, 0022, 0025.
**Model:** Opus (atomic exclusive locks, creator-only draft privacy, access-filtered rating averages, pool move on publish).
**Done when (build plan):** lock and draft-privacy tests pass.

## What already exists

- Trash (S16) with the wrapper pattern for dispatch functions (chores renamed the previous ones `*_before_chores`); file storage (S15) with purposes, pools, finalize dispatch by purpose (S19c); dashboard registry (S17); tasks show the personal + Home context pattern (S18).
- No recipe tables, pages or widgets. `recipes` is still an unbuilt section in the sidebar.

## Model

**One canonical recipe row** (`private.recipes`) owned by exactly one context: a person (Personal space) or a Home. Its creator is kept for attribution only and never grants anything by itself.

- **Status** `draft` or `published`. A **draft** always belongs to its creator's Personal space (`owner_user_id` = creator), whatever its intended destination; the destination is a separate column (`draft_home_id`, null = Personal). So no Home query can ever return a draft: privacy holds by construction, not by a filter someone can forget. Publishing moves ownership to the destination (a Home: `owner_home_id`, `owner_user_id` null).
- **Fields:** name (draft: may be empty; published: 1–200 visible characters), ingredients (ordered rows: name 1–200, optional positive quantity, optional supported unit, optional note ≤ 200; at most 100), steps (ordered, each 1–2,000; at most 100), optional servings (whole number 1–999) with an optional label ≤ 40 ("pieces"), optional prep and cook time (whole minutes 0–10,080, distinct), manual tags (≤ 20, each 1–40, compared case- and accent-insensitively), notes (≤ 5,000), one optional cover photo.
- **Published minimum:** a visible name and at least one ingredient or step. Drafts may be anything, including empty.
- **Quantities** are exact fractions (numerator/denominator), with the way they were typed (`decimal` or `fraction`), so "1/3" stays a third and "0.25" stays 0.25. Input accepts `2`, `1.5`, `1,5`, `1/2`, `1 1/2`. Units: g, kg, mg, ml, cl, dl, l, tsp, tbsp, cup, fl oz, oz, lb, piece, pinch, clove, slice, can, jar, pack, bunch, sprig, handful. Anything else goes in the note. No conversions.
- **Latest-only:** saving replaces the content; no history, no restore. `revision` is only a concurrency token. Audit stores ids and actions, never content.
- **Deleting** a published recipe (or discarding a draft) moves it to the trash for 7 days with its cover; restoring brings back the whole recipe, never older content.

## Exclusive editing lock (published recipes)

- `private.recipe_edit_locks`: one row per recipe (primary key), holder account, a per-edit-session token, `expires_at`.
- **Acquire** when entering edit mode (not when viewing): one `insert … on conflict … do update where expired or mine`, so two simultaneous attempts cannot both win. Answers `acquired` (with the recipe's current revision and content), `locked` (someone else; Home viewers see "being edited by {member}", the Personal owner sees "open in another tab or device" with a **Take over** for their own lock only), `not_found`, `not_permitted`.
- **Heartbeat** every 30 s while the editor is open; the lock lasts **2 minutes** after the last heartbeat (crash, closed tab, lost connection free it within 2 minutes). **Inactivity:** after 13 minutes without input the editor warns, at 15 minutes it stops heartbeating and the lock lapses; the unsaved changes stay on the page (and in session storage) for a reviewed retry.
- **Release** on save, Cancel, and leaving the page (`pagehide` beacon), best effort.
- **Save** rechecks, in one transaction: the recipe exists and is not deleted, the caller holds an unexpired lock with this token, the caller may still edit, and the revision matches. Any failure changes nothing and says which (`lock_lost`, `conflict`, `not_permitted`, `not_found`). A lost lock never overwrites: if the recipe changed meanwhile the person reloads and re-applies; if it did not, they can re-acquire and save.
- Leaving or removal from a Home ends that person's locks on its recipes at once (membership trigger). Deleting a recipe someone else is editing answers `locked`. Nobody can force-unlock another person's lock (no admin recovery action in this step).
- **Drafts** use no lock (only their creator can open them); two tabs of the same creator are protected by the revision check: the second save answers `conflict` and keeps its text on the page.

## Who may do what (defaults picked, Ward may override)

| Action                                              | Personal space             | Home: any current member | Home: creator (current member) | Home: `manageHomeRecipes` |
| --------------------------------------------------- | -------------------------- | ------------------------ | ------------------------------ | ------------------------- |
| View published recipes, search, cooking mode, scale | owner                      | yes                      | yes                            | yes                       |
| Favorite, rate                                      | owner                      | yes                      | yes                            | yes                       |
| Create and publish into the context                 | owner                      | yes                      |                                |                           |
| Edit (lock) and delete to trash                     | owner                      |                          | yes                            | yes                       |
| Drafts                                              | only their creator, always |                          |                                |                           |

`manageHomeRecipes` is a new delegable capability (Owner always; Administrators when granted). Engine actions `home.recipes.*` in `packages/domain`; SQL `private.can_edit_recipe`. Restore from trash follows the S16 generic rule (who deleted it, plus Owner and Administrators with `manageHomeSettings`), as for tasks.

## Drafts and publishing

- **Save draft** (create or update, revision-checked, client id so a retry returns the same draft), **Continue editing**, **Discard draft** (to the personal trash), **Publish**.
- **My drafts** (`/recipes/drafts`): every draft of mine with last edited, intended destination and Resume; never anywhere else (no Home list, search, widget, rating or favorite).
- **Publish** shows the destination and its audience ("Everyone in {Home} can see it" / "Only you can see it") and needs that confirmation. It rechecks membership, the minimum and the fields; a client publish id makes a retry or double click answer `already_published` instead of a second recipe. Publishing to a Home moves a draft's cover from the personal storage pool to the Home's, quota-checked (`storage_full`, nothing changes).
- **Losing the destination:** when the creator leaves or is removed from the intended Home (or it is deleted), the draft's destination is cleared and flagged; My drafts says so and the person picks Personal or another Home they belong to.
- A draft is never a version of a published recipe; editing a published recipe uses the lock.

## Search, tags, favorites, sorting

- Library per context (Personal space or a Home): search by name and ingredient name (partial, case- and accent-insensitive; a result matched only through an ingredient says which one), tag filter (**all** selected tags; labelled), **Favorites** filter, sort by name A–Z/Z–A, newest/oldest added, most/least recently updated (substantive edits only), ties broken by name then id. 24 per page with "Show more"; counts only over what the viewer may see.
- Favorites are per member and per context (`private.recipe_favorites`: account, recipe, context Home or Personal), so S25's destination-only favorites fit without change. A favorite never grants access.

## Ratings

- 1–5 whole stars, one per member per recipe, change or clear; published recipes only. Shown: my rating, and the average and count over **current members of the recipe's context** (Personal: only the owner's). Never individual ratings or raters. Ratings of people who left stay stored but do not count while they are not members.

## Serving scaling and cooking mode

- Scaling is a view: `?servings=N` (1–999) on the detail and cooking pages; exact rational arithmetic in `packages/domain/src/recipes`; original and selected servings both shown; scaled values marked; no-quantity ingredients unchanged and labelled; without a recorded yield scaling is off with the reason. Display: fractions for fraction-typed values when the denominator is ≤ 16, otherwise up to 2 decimals with "≈" and the exact value on request.
- **Cooking mode** (`…/recipes/:id/cook`): one step at a time, large text, Previous/Next, "Step 2 of 6", ingredient checklist (scaled) with Reset, keep-screen-awake toggle only where the Wake Lock API exists (explains when unavailable or refused, released on exit), back to the recipe. Step and checklist are kept in session storage for this tab only. Every 60 s and on focus it checks the recipe: changed → banner "This recipe was changed" with Reload (never swaps silently); gone or no access → unavailable state. No lock, no writes. No steps → explains and links to the recipe.

## Cover photo

- One optional cover per recipe or draft. JPEG, PNG or WebP up to 10 MB, re-encoded server-side to a WebP of at most 1600 px on the long side without metadata (S15 pipeline, purpose `recipe_cover`). Upload during editing, applied only by Save (replace or remove); an unsaved upload is retired by the expiry job. Charged to the pool of where the recipe lives (Personal for drafts). Readable by whoever may see the recipe now (`authorize_file_read`); drafts' covers only by their creator. Missing cover: neutral placeholder with no alt text clutter (decorative).

## Widgets

- New widget type **Recipes** (personal dashboard: Personal recipes or a bound Home; Home dashboard: that Home). Settings: mode **My favorites**, **Recently added**, **Highest rated**, **Random recipe**; 1, 3 or 5 cards (Random: 1). Card: cover or placeholder, name, open link; Highest rated shows the context average and count. Random picks with a seed held by the widget and changes only on **Show another**. Empty states per mode. Data read with the viewer's session; a Home the viewer left shows the S17 unavailable state.

## Interface

`/recipes` and `/homes/:id/recipes` (library), `/recipes/new` and `/homes/:id/recipes/new`, `/recipes/drafts` and `/recipes/drafts/:id`, `…/recipes/:recipeId` (detail with servings, rating, favorite, edit, delete), `…/recipes/:recipeId/edit` (lock), `…/recipes/:recipeId/cook`. Editor: React Hook Form + Zod; ingredient and step rows with Move up/down buttons (no drag needed), warns before leaving with unsaved changes. Sidebar Recipes follows the open Home. nl and en, keyboard and screen reader, light and dark.

## API

`GET/POST /api/v1/recipes` (list; create draft or publish), `GET/PATCH/DELETE /api/v1/recipes/:id` (detail; save draft or, with lock token, published; to trash), `POST /api/v1/recipes/:id/publish`, `POST/PATCH/DELETE /api/v1/recipes/:id/lock` (acquire or take over, heartbeat, release), `PUT/DELETE /api/v1/recipes/:id/rating`, `PUT/DELETE /api/v1/recipes/:id/favorite`, `GET /api/v1/recipes/tags`, `GET /api/v1/recipes/drafts`, `POST /api/v1/recipes/cover-uploads` (intent; finalize through the existing upload route), `GET /api/v1/recipes/widget`. Same CSRF, JSON, size, session and outcome mapping as earlier steps.

## Tests

- **Database:** draft privacy (another member, a Home manager, the Owner, another Home, anon never see a draft or its cover in list, get, search, tags, widget, rating or favorite, including a draft aimed at their Home); publish minimum, destination recheck, publish idempotence, destination lost on leave; locks (acquire, locked for others, expiry, stale save after expiry, save with wrong token, revoked membership mid-edit, delete while locked, take over by the same account); revision conflicts for drafts; permissions matrix (creator, manager, member, non-member, departed creator); search (accents, ingredient match, tags all, favorites, sort ties); ratings (average over current members only, departed rater excluded, drafts unratable); favorites per member; trash restore and purge with the cover; cover read access. **Concurrency:** two sessions acquire the same lock at once (one wins); two publishes of the same draft (one recipe); save racing lock expiry.
- **Unit:** quantity parsing and formatting, rational scaling (4→6, 4→2, thirds, no quantity, no yield), permission matrix, schemas, routes, components with axe.
- **Playwright:** create a draft, a second member cannot see it, publish it to the Home, the member sees and favorites and rates it; one member edits while the other sees the locked state; cooking mode with scaling; widget; axe in both themes.

## Out of scope (with the step that brings it)

URL import, cross-context sharing, impact-reviewed deletion of shared recipes and per-destination editors (S25); meal planner, shopping transfer and unavailable-recipe states in meals (S26, S27); Ora actions (S45); wall-display presentation (S43–S44: drafts can never reach a Home query anyway); an Owner/administrator lock recovery action (not provided; spec allows it only if explicitly permissioned later).

## Defaults picked (Ward may override)

1. Permissions as in the table; new capability `manageHomeRecipes`.
2. Lock lasts 2 minutes after the last heartbeat (every 30 s); inactivity warning at 13 and lapse at 15 minutes; Take over only for one's own lock.
3. Limits: name 200, 100 ingredients, 100 steps, step 2,000, notes 5,000, 20 tags of 40, servings 1–999, times up to 7 days in minutes, 24 per page, 2,000 recipes per context.
4. Tag filter matches all selected tags.
5. Cover: JPEG/PNG/WebP ≤ 10 MB, stored as WebP ≤ 1600 px.
6. Discarding a draft puts it in the personal trash (7 days), like every other deletion.
7. Ratings of members who left are kept but not counted.
8. No notifications and no Realtime in this step (pages refresh after one's own changes; cooking mode checks every 60 s).
9. The sidebar's Meals entry now opens Recipes (`/recipes`, or the open Home's recipes) until the meal planner (S26–S27) exists.
10. `recipe_widget` and `set_recipe_rating` give every parameter a SQL default of null, so the generated types let the Personal widget omit the Home and clearing a rating omit the stars.
11. Unit names are two plain messages each (singular for exactly one, plural otherwise) instead of ICU plurals.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API and data layer
- [x] Interface
- [x] Playwright
- [x] Docs
- [x] Full suite
- [x] Independent review (PASS, 0 blocker/high, 8 medium, 8 low)
