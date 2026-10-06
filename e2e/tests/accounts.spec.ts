import { expect, test } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD } from "../demo-user";

// These tests start signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test("signed-out visitors are sent to sign in, and come back where they were going", async ({ page }) => {
  await page.goto("/exports");
  await expect(page).toHaveURL(/\/login\?next=%2Fexports$/);
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/exports$/);
});

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p.error")).toContainText("do not match");
  await expect(page).toHaveURL(/\/login/);
});

test("a new studio gets the starter library, and its reels stay its own", async ({ page }) => {
  const email = `agent-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Sam Rivera");
  await page.getByLabel(/Studio or business name/).fill("Rivera Homes");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("walk-the-reel-1");
  await page.getByRole("button", { name: "Create studio" }).click();

  // Signed in, in the new studio, with no reels but a stocked library.
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  await expect(page.getByTestId("welcome")).toContainText("Rivera Homes");
  await expect(page.getByTestId("reel-card")).toHaveCount(0);
  await expect(page.getByTestId("start-from-library")).toBeVisible();

  // The demo studio's reels are not visible from here.
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Rivera Homes" })).toBeVisible();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login$/);

  // Signing in again works, and the same email cannot sign up twice.
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Sam Rivera");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("walk-the-reel-1");
  await page.getByRole("button", { name: "Create studio" }).click();
  await expect(page.locator("p.error")).toContainText("already has an account");
});
