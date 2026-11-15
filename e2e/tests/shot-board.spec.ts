import { expect, test } from "@playwright/test";

test("right-click shot actions close with Escape and retain card focus", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-blank-board").click();
  await page.getByRole("button", { name: "+ Add shot", exact: true }).click();
  const card = page.getByRole("region", { name: "Shot board", exact: true }).getByRole("article").first();
  await card.click({ button: "right" });
  await expect(card.getByRole("button", { name: "Close shot actions", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Close shot actions", exact: true })).toBeHidden();
  await expect(card.getByRole("button", { name: "Shot actions ...", exact: true })).toBeFocused();
});
