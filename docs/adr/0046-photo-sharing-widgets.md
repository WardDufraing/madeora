# ADR 0046: Photo sharing, removal and widgets

- **Status:** Accepted for S36 within the approved architecture (§10, §15, §37), CLAUDE.md (authorization C, database access A, data fetching B) and ADR 0045. The rules the spec leaves to a supporting Photos specification are the defaults in the S36 brief (`plans/steps/S36-brief.md`, "Open in the spec"), accepted by the owner on 5 Nov 2026.
- **Date:** 2026-11-05
- **Step:** S36.

## Context

Modules.md §4.7 asks for cross-Home album sharing without copying (view or contribute per Home), a photo widget with slideshow, and two distinct album actions: "Remove from this album" and "Delete from library" with an impact preview. Wall displays come with S43/S44.

## Decision

**A share is a row, not a copy.** `private.photo_album_shares (album, home, access)`. Photos, files and pools are untouched by sharing; every read decides again.

**One visibility rule.** A person sees a photo when they can see its own library, or when it is in an album they can see now and it still belongs there (`private.photo_in_album_visible`): a photo of the album's own library; a personal photo while its owner can still see the album; a Home's photo while that Home still has a share. So leaving a Home, losing a share or a photo moving to the trash hides it at once from every album page, picture link (`authorize_photo_read`) and widget, without a cleanup job. Memberships that only a share allowed are removed when that share ends, so a later re-share does not bring them back.

**Who may do what.** Sharing: a personal album's owner, a Home album's photo managers (`manageHomePhotos`), towards Homes they belong to now, never the album's own Home, at most 20. Adding: the album's editor (S35), and members of a contribute Home, each only photos they may share (their personal photos; Home photos they uploaded or manage in a Home the album is shared with). Removing from an album: the editor any photo, others what they added or may change. Removing a shared album from a Home: the sharer or that Home's photo managers. Deleting from a library keeps the S35 rule. All helpers return false, never null, for people outside the album's Home.

**Album deletion ends its shares**, so restoring an album from the trash never restores a share.

**Deletion impact** (`photo_deletion_impact`) names only albums and Homes the person can see and flags the rest, without names or counts. It changes nothing.

**Photo widget.** One widget type `photos` (personal, Home, Home-bound) with a Zod-validated source (one photo, up to 50 picked photos kept in order, or one album), static or slideshow, interval and fit. `resolve_photo_widget` returns what this viewer may see in this context (personal: own personal photos and albums; Home: its photos, its albums, albums shared with it and their photos), never a substitute. The client slideshow pauses off-screen and in hidden tabs, starts paused under reduced motion, has pause/play and previous/next, and asks again every minute and whenever a picture fails to load.

## Consequences

- Album and photo reads now evaluate access per photo; at the S35 limits (2 000 photos per album, 60 per page) this is acceptable, and the widget reads at most 100 photos.
- Already downloaded files and signed links issued in the last 60 seconds cannot be revoked; the sharing dialog says so.
- Rollback: drop `private.photo_album_shares` and the four new public functions, and re-run the S35 definitions of the replaced functions. Database rollbacks are not automatic.
