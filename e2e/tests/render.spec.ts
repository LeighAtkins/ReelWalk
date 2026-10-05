import { expect, test, type Page } from "@playwright/test";

// 1x1 PNG. Enough for the still-image template to produce a real MP4.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function createProperty(page: Page, title: string) {
  await page.goto("/");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Address").fill("1-24-5 Kanda Sudacho");
  await page.getByRole("button", { name: "Create property" }).click();
  await expect(page).toHaveURL(/\/properties\//, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function uploadMedia(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByTestId("media-file").setInputFiles(file);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByTestId("upload-status")).toHaveText("Uploaded.");
  await expect(page.getByTestId("media-list")).toContainText(file.name);
}

test("create a property, upload media, render and preview the reel", async ({ page }) => {
  const title = `E2E listing ${Date.now()}`;
  await createProperty(page, title);
  await uploadMedia(page, { name: "front.png", mimeType: "image/png", buffer: PNG });

  await page.getByRole("radio", { name: /^Open house/ }).check();
  await page.getByRole("textbox", { name: "Caption" }).fill("Sunny corner unit");
  await page.getByRole("button", { name: "Render reel" }).click();

  const job = page.getByTestId("job-card").first();
  await expect(job.getByTestId("job-status")).toHaveAttribute("data-status", /QUEUED|RUNNING|SUCCEEDED/);
  // The page refreshes itself while the job is active; no manual reload here.
  await expect(job.getByTestId("job-status")).toHaveAttribute("data-status", "SUCCEEDED", { timeout: 4 * 60_000 });

  const video = job.getByTestId("job-video");
  await expect(video).toBeVisible();
  const response = await page.request.get((await video.getAttribute("src"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("video/mp4");
  await expect(job.getByRole("link", { name: "Download MP4" })).toBeVisible();

  // The property dashboard and the render dashboard both show the result.
  await page.goto("/");
  await expect(page.getByRole("listitem").filter({ hasText: title }).getByTestId("job-status")).toHaveAttribute(
    "data-status",
    "SUCCEEDED",
  );
  await page.goto("/renders");
  await expect(page.getByRole("row").filter({ hasText: title }).getByTestId("job-status")).toHaveAttribute(
    "data-status",
    "SUCCEEDED",
  );
});

test("a broken render fails after its retries and can be retried manually", async ({ page }) => {
  await createProperty(page, `E2E broken ${Date.now()}`);
  // Passes upload validation (it is an .mp4) but cannot be decoded.
  await uploadMedia(page, { name: "corrupt.mp4", mimeType: "video/mp4", buffer: Buffer.from("this is not a video") });

  await page.getByRole("button", { name: "Render reel" }).click();

  const job = page.getByTestId("job-card").first();
  await expect(job.getByTestId("job-status")).toHaveAttribute("data-status", "FAILED", { timeout: 4 * 60_000 });
  await expect(job).toContainText("attempt 3");
  await expect(job.locator(".error")).not.toBeEmpty();

  await job.getByRole("button", { name: "Retry render" }).click();
  await expect(job.getByTestId("job-status")).toHaveAttribute("data-status", /QUEUED|RUNNING/);
  // Still exactly one job: the retry reused the row instead of creating another.
  await expect(page.getByTestId("job-card")).toHaveCount(1);
});

test("rejects unsupported uploads before they reach storage", async ({ page }) => {
  await createProperty(page, `E2E reject ${Date.now()}`);
  await page.getByTestId("media-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByTestId("upload-status")).toContainText("Unsupported file type");
});
