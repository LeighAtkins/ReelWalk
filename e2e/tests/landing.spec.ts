import { expect, test } from "@playwright/test";

test.describe("signed out", () => {
  // An Australian phone: the page prices in A$ (ADR 0085), placed by the time zone before paint.
  test.use({ storageState: { cookies: [], origins: [] }, timezoneId: "Australia/Sydney", locale: "en-AU" });

  test("/ is the landing page, with the plans and the billing switch", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("hero-title")).toBeVisible();
    await expect(page.getByTestId("hero-cta")).toHaveAttribute("href", "/signup");
    await expect(page.getByTestId("sample")).toBeVisible();

    const pricing = page.getByTestId("pricing");
    await expect(pricing.getByTestId("plan-free")).toBeVisible();
    await expect(pricing.getByTestId("plan-agent")).toBeVisible();
    await expect(pricing.getByTestId("plan-office")).toBeVisible();
    // "Start free, then Agent" goes to sign-up and remembers the pick (ADR 0081), never to checkout.
    await expect(pricing.getByTestId("cta-agent")).toHaveAttribute("href", "/signup?intent_plan=AGENT&intent_interval=month");
    await expect(pricing.getByTestId("cta-agent-yearly")).toHaveAttribute("href", "/signup?intent_plan=AGENT&intent_interval=year");
    await expect(pricing.getByTestId("founding-note")).toContainText("FOUNDING50");
    await expect(pricing.getByTestId("price-small-print")).toHaveText("Prices in Australian dollars. GST included where it applies.", { useInnerText: true });
    await expect(pricing.getByTestId("plan-agent")).toContainText("A$39", { useInnerText: true });

    // The monthly/yearly switch is two radios and a CSS rule: yearly prices show once it is flipped.
    // Prices are written in both currencies (ADR 0085); the A$ ones are the ones showing here.
    const agent = pricing.getByTestId("plan-agent").locator('[data-cur="aud"]');
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
    await expect(page.getByTestId("top-cta")).toHaveAttribute("href", "/signup");
  });
});

// Everyone outside Australia sees US$ plus tax (ADR 0085), and anyone can switch.
test.describe("signed out, outside Australia", () => {
  test.use({ storageState: { cookies: [], origins: [] }, timezoneId: "America/New_York", locale: "en-US" });

  test("/pricing is in US dollars, and the toggle switches to A$ and is remembered", async ({ page, context }) => {
    await page.goto("/pricing");
    const pricing = page.getByTestId("pricing");
    await expect(pricing.getByTestId("plan-agent")).toContainText("US$29", { useInnerText: true });
    await expect(pricing.getByTestId("plan-agent")).not.toContainText("A$39", { useInnerText: true });
    await expect(pricing.getByTestId("price-small-print")).toHaveText("Prices in US dollars, plus applicable tax.", { useInnerText: true });
    await expect(pricing.getByTestId("founding-note")).toContainText("US$14.50 a month", { useInnerText: true });
    expect((await context.cookies()).find((cookie) => cookie.name === "rw_country")?.value).toBe("ZZ");

    await pricing.getByTestId("currency-aud").click();
    await expect(pricing.getByTestId("plan-agent")).toContainText("A$39", { useInnerText: true });
    await expect(pricing.getByTestId("price-small-print")).toHaveText("Prices in Australian dollars. GST included where it applies.", { useInnerText: true });
    await page.reload();
    // The pick is a cookie the server reads: A$ from the first byte, no flash.
    await expect(pricing.getByTestId("plan-agent")).toContainText("A$39", { useInnerText: true });
    await expect(pricing.getByTestId("currency-aud")).toHaveAttribute("aria-pressed", "true");
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
