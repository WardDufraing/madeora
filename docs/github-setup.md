# GitHub setup for `WardDufraing/madeora`

These are the repository settings the owner changes by hand. Claude cannot change them. Each part says where to click, what to choose and how to check that it worked.

**Plan limits (checked 13 October 2026 on docs.github.com):** the repository is **private** on **GitHub Free**.

- GitHub Actions includes 2,000 minutes a month for private repositories. With no payment method on file, Actions stops when the quota runs out. It does not charge.
- Branch protection and rulesets are **not available** for private repositories on GitHub Free. They are free for public repositories, and they come with paid plans such as GitHub Pro. So part B can only be done after one of those changes. The owner has to approve that, because of the €0 rule.
- GitHub secret scanning is not free for private repositories. CI runs the open-source gitleaks scanner instead (the `Secret scan` check).
- Code owners (`.github/CODEOWNERS`) only take effect on public repositories or paid plans. Until then the file just documents who owns what, and your review happens because you are the one who merges.

## A. Settings to change now (all free)

### A1. Restrict which actions may run, and make the workflow token read-only

1. Open https://github.com/WardDufraing/madeora/settings/actions. You can also open the repository, click **Settings** in the top menu, then in the left sidebar click **Actions** → **General**.
2. Under **Actions permissions**, select **Allow WardDufraing, and select non-WardDufraing, actions and reusable workflows**.
3. Tick **Allow actions created by GitHub**.
4. Leave **Allow actions by Marketplace verified creators** unticked.
5. In the box **Allow specified actions and reusable workflows**, paste exactly:
   ```
   pnpm/action-setup@*
   ```
6. If the page shows the checkbox **Require actions to be pinned to a full-length commit SHA**, tick it. The CI workflow already pins every action that way.
7. Click **Save** under that section.
8. Scroll down to **Workflow permissions**. Select **Read repository contents and packages permissions**.
9. Untick **Allow GitHub Actions to create and approve pull requests**.
10. Click **Save** under that section.

**Check it worked:** reload the page. Both sections show your choices. On the next pull request, every check under **Checks** still starts. If a check fails with "action is not allowed", one of the actions is missing from the list in step 5. Tell Claude which one.

### A2. Allow merge commits only

`production` must contain exactly the `main` commits that were released (ADR 0002), so squash and rebase merges are switched off.

1. Open https://github.com/WardDufraing/madeora/settings. This is **Settings** → **General**.
2. Scroll to **Pull Requests**.
3. Keep **Allow merge commits** ticked.
4. Untick **Allow squash merging**.
5. Untick **Allow rebase merging**.

**Check it worked:** on any open pull request, the green merge button reads **Merge pull request** and has no dropdown offering squash or rebase.

### A3. Turn on Dependabot alerts

Dependabot alerts are free for private repositories. They warn you about vulnerable dependencies between pull requests. The `Dependency audit` check covers the pull requests themselves.

1. Open https://github.com/WardDufraing/madeora/settings/security_analysis. This is **Settings**, then in the left sidebar **Advanced Security** (on some accounts it is called **Code security**).
2. Next to **Dependabot alerts**, click **Enable**.
3. Leave **Dependabot security updates** and **Dependabot version updates** off for now. They open pull requests automatically, and each pull request uses Actions minutes.

**Check it worked:** the **Security** tab of the repository now shows **Dependabot alerts**. Today it may list the `braces` advisory, which has a recorded exception until 31 December 2026 (`tools/repo-checks/audit-exceptions.json`).

### A4. Make sure Actions can never charge you

1. Open https://github.com/settings/billing. This is your profile picture (top right) → **Settings** → **Billing and licensing**.
2. Open **Payment information**. Check that no card or PayPal account is saved. With no payment method, GitHub blocks usage at the free quota and never charges.
3. If a payment method is saved, open **Budgets and alerts**. Make sure the Actions budget is **$0** with **Stop usage when budget limit is reached** ticked.

**Check it worked:** **Billing and licensing** → **Usage** shows Actions minutes used this month against the 2,000 included.

## B. Protect `main` and `production` (only once the repository is public or on a plan with rulesets)

Skip this part while the repository is private on GitHub Free. The **New ruleset** button will be missing or say it needs an upgrade. Until then, CI reports every check, but only your own discipline stops a red merge or a direct push.

Do these steps twice, once for `main` and once for `production`.

1. Open https://github.com/WardDufraing/madeora/settings/rules. This is **Settings** → **Rules** → **Rulesets**.
2. Click **New ruleset** → **New branch ruleset**.
3. **Ruleset name:** type `main` (the second time, type `production`).
4. **Enforcement status:** choose **Active**.
5. **Bypass list:** leave it empty. Do not add yourself, any app or Claude.
6. Under **Target branches**, click **Add target** → **Include by pattern**. Type `main` (the second time, `production`), then click **Add inclusion pattern**.
7. Under **Rules**, tick:
   - **Restrict deletions**
   - **Require a pull request before merging**. Set **Required approvals** to `0`. Claude opens pull requests under your GitHub account, and GitHub never lets the author approve their own pull request, so any number above 0 would block every merge. Your approval is the act of merging. Leave **Require review from Code Owners** unticked for the same reason. Under **Allowed merge methods**, keep only **Merge**.
   - **Require status checks to pass**.
     - For the **main** ruleset, tick **Require branches to be up to date before merging**.
     - For the **production** ruleset, leave **Require branches to be up to date before merging** unticked. Releases are merge commits, so after the first release `production` always has a merge commit that `main` lacks. With this box ticked, every later release would be blocked.
     - Then click **Add checks** and add each of these names exactly. They appear in the list once CI has run on at least one pull request.
     - `Spec guard`
     - `Spec guard (trusted)`
     - `Secret scan`
     - `Dependency audit`
     - `Format, lint, typecheck, unit tests, build`
     - `E2E smoke tests`
     - For the **production** ruleset only, also add `Release source`.
   - **Block force pushes**
8. Click **Create**.

**Check it worked:**

- **Settings** → **Rules** → **Rulesets** lists `main` and `production`, both **Active**.
- On a pull request with a red check, the merge button is grey and says merging is blocked.
- A direct push is refused. Running `git push origin HEAD:main` from any clone fails with a message that names the ruleset.
- A pull request from any branch other than `main` into `production` shows `Release source` as failed and cannot be merged.

## C. The `production` branch

Claude creates `production` from `main`'s seed commit `33e0576`, and only after your yes (build plan S02).

**Check it worked:** open https://github.com/WardDufraing/madeora/branches. `production` is listed. Its latest commit is "docs: seed repository with specification and references".

## D. How a release works (after S49 wires up deployment)

1. Open https://github.com/WardDufraing/madeora/compare/production...main.
2. Click **Create pull request**. The title is `release: <date>`.
3. Wait until every check is green, including `Release source`.
4. Read the list of commits and the diff. This is exactly what ships.
5. Click **Merge pull request** → **Confirm merge**. Only a merge into `production` deploys to production.
