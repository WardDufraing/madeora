import { expect, test } from "../support/browser";

test("the dashboard loads with its heading inside the app shell", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Dashboard · Madeora");
  await expect(
    page
      .getByRole("main")
      .getByRole("heading", {
        level: 1,
        name: /^(Good (morning|afternoon|evening)|Goedemorgen|Goedemiddag|Goedenavond)/,
      }),
  ).toBeVisible();
});
