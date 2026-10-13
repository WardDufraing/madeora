import { expect, test } from "@playwright/test";

test("home page loads with its heading and no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Madeora");
  await expect(page.getByRole("heading", { level: 1, name: "Madeora" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
