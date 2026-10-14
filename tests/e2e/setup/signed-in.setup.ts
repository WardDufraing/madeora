import { test as setup } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";

export const storageStatePath = "playwright/.auth/user.json";

// One confirmed synthetic account, signed in once, for every test that only needs to be inside
// the app. Tests about signing in and out make their own accounts and never use this session,
// because signing out ends it for every context that shares it.
setup("sign in the shared test account", async ({ page, baseURL }) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.context().storageState({ path: storageStatePath });
});
