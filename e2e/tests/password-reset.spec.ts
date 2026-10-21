import { expect, test, type APIRequestContext } from "@playwright/test";

// These tests start signed out.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The local stack has no email provider, so the app keeps the messages it
 * would have sent and hands them out at /api/dev/mailbox (DEV_MAILBOX=true in
 * docker-compose.yml). This waits for the reset link addressed to `email`.
 */
async function resetLinkFor(request: APIRequestContext, email: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(email)}`);
        const { messages } = (await response.json()) as { messages: { subject: string; text: string }[] };
        const latest = messages.filter((message) => /reset/i.test(message.subject)).at(-1);
        link = latest?.text.match(/https?:\/\/\S+\/reset\/\S+/)?.[0];
        return link;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return link!;
}

test("a forgotten password is reset from an emailed link, which then stops working", async ({ page, request }) => {
  const email = `forgetful-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Jo Park");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("first-password-1");
  await page.getByRole("button", { name: "Create studio" }).click();
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  await page.goto("/account");
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login$/);

  // The login page leads to the forgot form, which answers the same for any address.
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page).toHaveURL(/\/forgot$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByTestId("forgot-sent")).toContainText("If that address has an account, we sent a link");

  // The link opens a form for a new password and signs this browser in.
  const link = await resetLinkFor(request, email);
  await page.goto(link);
  await expect(page.getByTestId("reset-form")).toBeVisible();
  await expect(page.getByText(`For ${email}`)).toBeVisible();
  await page.getByLabel(/^New password/).fill("second-password-2");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page).toHaveURL(/\/account\?saved=password$/);
  await expect(page.getByText("Password changed.")).toBeVisible();

  // The link was spent.
  await page.goto(link);
  await expect(page.getByTestId("reset-expired")).toContainText("expired or was already used");

  // Only the new password signs in.
  await page.goto("/account");
  await page.getByTestId("sign-out").click();
  // Sign-out is a server action that ends on /login. Going to /login before it
  // lands raced it: still signed in, /login sent the browser home, and the
  // Email field below never appeared (two 5-minute timeouts in CI, ADR 0054).
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("first-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p.error")).toContainText("do not match");
  // The refused attempt reloads the form empty, so the email goes in again.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("second-password-2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an unknown address gets the same answer and no email", async ({ page, request }) => {
  const email = `nobody-${Date.now()}@example.com`;
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByTestId("forgot-sent")).toContainText("If that address has an account");
  const response = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(email)}`);
  expect(((await response.json()) as { messages: unknown[] }).messages).toHaveLength(0);
});

test("a made-up reset link is refused", async ({ page }) => {
  await page.goto(`/reset/${"x".repeat(43)}`);
  await expect(page.getByTestId("reset-expired")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask for a new link" })).toHaveAttribute("href", "/forgot");
});
