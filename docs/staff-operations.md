# Madeora staff: owner guide

Madeora staff review requests that no Home member may decide themselves. The first such task is verified Home ownership recovery (S12b): a member whose Home's Owner has permanently lost their account asks Madeora to make them the Owner. Background: `architecture.md` §43, [ADR 0015](adr/0015-staff-operations.md) and [ADR 0016](adr/0016-ownership-recovery.md).

A staff member is an ordinary Madeora account on the staff list of one Supabase project. Being staff gives no access to any Home; it only opens the staff pages. The list is per project: being staff on `madeora-preview` does not make you staff on `madeora-production`.

## Add a staff member

1. Make sure the person has a Madeora account in that environment with a confirmed email (they signed up and clicked the confirmation link).
2. Open https://supabase.com/dashboard/projects and click the project (`madeora-preview` or `madeora-production`).
3. In the left sidebar click **SQL Editor**, then **+** (or **New query**).
4. Paste this, replace `name@example.com` with their sign-in email, and click **Run**:

   ```sql
   insert into private.madeora_staff (user_id, note)
   select id, 'Added by Ward' from auth.users
   where email = 'name@example.com' and email_confirmed_at is not null
   returning user_id;
   ```

5. The result shows one row with an id. **No rows** means the email has no confirmed account in this project: check the spelling, or ask them to confirm their email first.
6. Check: the person signs in and opens **Settings**. A **Madeora staff** card with **Ownership recovery requests** appears at the bottom.

## Remove a staff member

Same steps, with:

```sql
delete from private.madeora_staff
where user_id = (select id from auth.users where email = 'name@example.com')
returning user_id;
```

The result shows one row. From their next page load the staff pages answer "not found" and the card disappears from Settings.

## See who is staff

```sql
select u.email, s.added_at, s.note
from private.madeora_staff s join auth.users u on u.id = s.user_id
order by s.added_at;
```

## Review an ownership recovery request

Every step you take is recorded with your account. Staff decisions need a sign-in within the last 15 minutes in the same browser: if Madeora says so, sign out, sign in again and repeat the step.

You never see requests about a Home you belong to, or that you made or that are about you: the review must be independent, so another staff member handles those. If you are the only staff member and belong to the Home, add a second staff member for it.

1. Open **Settings**, click **Ownership recovery requests**, then the Home's name.
2. Read the statement and who asked (name, confirmed email, role, member since). Read the Owner's confirmed email, last sign-in and whether they opened the Home since the request.
3. Choose **Start the review (emails the Owner)** and click **Save decision**. "Decision saved. The Owner was emailed." appears. If it says the email failed, contact the Owner another way.
4. Verify outside Madeora before approving:
   1. Contact the person who asked, for example a video call where they show ID that matches their name.
   2. Try to reach the Owner yourself, at the email shown and through anyone the statement names.
   3. Check that the Owner really cannot regain access through normal account recovery ("Forgot password" on the sign-in page).
   4. If anything is unclear, choose **Pause** with a note, or **Reject** with a note.
5. To approve, choose **Approve**, choose what happens to the former Owner (**Stays as a Member** unless there is a reason to remove them), write in **Note** what you verified (at least 10 characters), and click **Save decision**. The Owner is emailed, and the other members have 14 days to object.
6. If someone objects, the request shows **Paused** and lists the objection. Look into it, then choose **Resume** (a fresh 14 days start) or **Reject**, with a note.
7. After 14 days without objection the person who asked can accept in the app. You do nothing more.

The request stops by itself, and cannot be approved or accepted, as soon as the Owner signs in or opens the Home. It then shows **Owner returned** or **Ended by the Owner**.

## Appeals

A former Owner can appeal after a recovery completed. The request then shows an **Appeals** card. Look into it, write your answer in **Your note to close this appeal** and click **Close appeal**. Closing changes nothing in the Home. If ownership should go back, the new Owner hands it over with the normal ownership transfer on the Home's leave page.
