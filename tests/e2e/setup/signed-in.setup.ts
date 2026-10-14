import { expect, test as setup } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";

export const storageStatePath = "playwright/.auth/user.json";

// One confirmed synthetic account, signed in once, for every test that only needs to be inside
// the app. Tests about signing in and out make their own accounts and never use this session,
// because signing out ends it for every context that shares it.
setup("sign in the shared test account", async ({ page, baseURL }) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  // Wait until the browser has recorded its timezone (S07), so pages opened with this session
  // never do the one-time refresh that follows a device's first report.
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === "md-timezone"))
    .toBe(true);
  await page.context().storageState({ path: storageStatePath });
});
