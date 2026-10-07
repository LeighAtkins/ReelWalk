import { expect, test as setup } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD, demoState } from "../demo-user";

/** Signs in once as the seeded demo user; every other test starts from this saved state. */
setup("sign in to the demo studio", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Reels" })).toBeVisible();
  await page.context().storageState({ path: demoState });
});
