import { expect, test as setup } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD, demoState, instagramState } from "../demo-user";

/** Signs in once as the seeded demo user; every other test starts from this saved state. */
setup("sign in to the demo studio", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Reels", exact: true })).toBeVisible();
  await page.context().storageState({ path: demoState });
});

/**
 * Signs up the studio the Instagram tests share and connects the pretend
 * account to it (which also comps it onto a plan that posts). It stays
 * connected: nothing else uses this studio, so there is nothing to undo.
 * Without the pretend Instagram the POST is a 404 and those tests skip.
 */
setup("sign up the Instagram studio", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Ines Grant");
  await page.getByLabel(/Studio or business name/).fill("Grant Listings");
  await page.getByLabel("Email").fill(`instagram-${Date.now()}@example.com`);
  await page.getByLabel(/^Password/).fill("walk-the-reel-ig");
  await page.getByRole("button", { name: "Create studio" }).click();
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  const connect = await page.request.post("/api/dev/instagram");
  expect([200, 404]).toContain(connect.status());
  await page.context().storageState({ path: instagramState });
});
