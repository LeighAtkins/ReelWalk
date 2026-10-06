import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", name);

test("a restaurant reel is built from the menu, a vibe and three shots", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-venue-reel").click();
  await expect(page).toHaveURL(/\/new\/venue$/);

  await page.getByTestId("venue-name").fill("Café Lumen");
  await page.getByLabel("What you serve").fill("Neapolitan pizza");
  await page.getByTestId("venue-price").fill("$12");
  await page.getByLabel("Instagram").fill("cafelumen");
  await page.getByTestId("dish-name").nth(0).fill("Margherita");
  await page.getByTestId("dish-price").nth(0).fill("$14");
  await page.getByTestId("dish-name").nth(1).fill("Burrata");
  await page.getByTestId("dish-price").nth(1).fill("$11");

  await page.getByRole("radio", { name: "Brunch club" }).click();

  // Three shots from the phone, uploaded here and picked in that order. The build button only wakes up after two.
  await expect(page.getByTestId("build-venue")).toBeDisabled();
  await page.getByRole("tab", { name: "Your phone" }).click();
  await page.getByTestId("venue-upload").setInputFiles(["exterior.jpg", "walkthrough.mp4", "living-room.jpg"].map(fixture));
  const picked = page.getByTestId("venue-clip").and(page.locator('[aria-pressed="true"]'));
  await expect(picked).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("build-venue")).toBeEnabled();
  await page.getByTestId("build-venue").click();

  // The draft opens in the editor: three clips, the hook and the dish labels, music on.
  await expect(page).toHaveURL(/\/reels\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByTestId("clip")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("text-bar").first()).toContainText("Café Lumen");
  await expect(page.getByTestId("text-bar").filter({ hasText: "Margherita · $14" })).toHaveCount(1);
  await expect(page.getByTestId("text-bar").filter({ hasText: "Burrata · $11" })).toHaveCount(1);
  await expect(page.locator(".bar-music")).toBeVisible();

  // The caption is ready to post.
  await page.getByTestId("export-button").click();
  await page.getByTestId("confirm-export").click();
  await expect(page).toHaveURL(/\/export$/);
  const caption = page.getByRole("textbox", { name: "Post caption" });
  await expect(caption).toHaveValue(/Brunch at Café Lumen/);
  await expect(caption).toHaveValue(/• Margherita · \$14/);
  await expect(caption).toHaveValue(/@cafelumen/);
});
