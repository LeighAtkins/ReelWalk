import { expect, test } from "@playwright/test";

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/ is the landing page, with the plans and the billing switch", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("hero-title")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try free - AI credits included" })).toBeVisible();
    await expect(page.getByTestId("sample")).toBeVisible();

    const pricing = page.getByTestId("pricing");
    await expect(pricing.getByTestId("plan-free")).toBeVisible();
    await expect(pricing.getByTestId("plan-agent")).toBeVisible();
    await expect(pricing.getByTestId("plan-office")).toBeVisible();
    await expect(pricing.getByTestId("cta-agent")).toHaveAttribute("href", "/try");

    // The monthly/yearly switch is two radios and a CSS rule: yearly prices show once it is flipped.
    const agent = pricing.getByTestId("plan-agent");
    await expect(agent.getByText(/billed yearly/)).toBeHidden();
    await pricing.getByTestId("interval").getByLabel(/Yearly/).check();
    await expect(agent.getByText(/billed yearly/)).toBeVisible();
    await expect(agent.getByText(/billed monthly/)).toBeHidden();
  });

  test("/pricing renders the plans on their own", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
    await expect(page.getByTestId("plan-agent")).toBeVisible();
    await expect(page.getByTestId("top-cta")).toHaveAttribute("href", "/try");
  });
});

test("signed in, / is still the reels home", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Reels", exact: true })).toBeVisible();
  await expect(page.getByTestId("hero-title")).toHaveCount(0);
});

test("signed in, /pricing shows the studio's plan and is linked from Account", async ({ page }) => {
  await page.goto("/account");
  await page.getByTestId("see-plans").click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByTestId("pricing")).toContainText("Your studio is on");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});
