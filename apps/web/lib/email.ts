import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

/**
 * Transactional email through Amazon SES (ADR 0016): password resets and
 * feedback. EMAIL_FROM ("ReelWalk <hello@reelwalking.com>") switches it on;
 * App Runner's instance role carries ses:SendEmail for the domain identity.
 *
 * Without EMAIL_FROM (local Compose, CI, unit tests) nothing leaves the
 * machine: the message is logged, and kept in memory for the dev mailbox
 * (/api/dev/mailbox, DEV_MAILBOX=true) so the end-to-end tests can read it.
 */

/** Where people write to us, and where feedback lands. */
export const SUPPORT_EMAIL = "hello@reelwalking.com";

export type EmailMessage = { to: string; subject: string; text: string; html: string };

// Terraform stores an absent value as "unset" (Parameter Store refuses empty values).
const isSet = (name: string) => Boolean(process.env[name]) && process.env[name] !== "unset";

export function isEmailConfigured(): boolean {
  return isSet("EMAIL_FROM");
}

let client: SESv2Client | null = null;

function ses(): SESv2Client {
  client ??= new SESv2Client({ region: process.env.AWS_REGION ?? "us-east-2" });
  return client;
}

/** The last messages "sent" without a provider, newest last. Only read by the dev mailbox. */
const devMailbox: (EmailMessage & { sentAt: Date })[] = [];
const DEV_MAILBOX_SIZE = 50;

export function devMailboxFor(to: string): (EmailMessage & { sentAt: Date })[] {
  const address = to.trim().toLowerCase();
  return devMailbox.filter((message) => message.to.toLowerCase() === address);
}

/** Sends one message. Throws when SES refuses it; callers decide whether that matters. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!isEmailConfigured()) {
    devMailbox.push({ ...message, sentAt: new Date() });
    if (devMailbox.length > DEV_MAILBOX_SIZE) devMailbox.splice(0, devMailbox.length - DEV_MAILBOX_SIZE);
    console.log(`email (not sent, EMAIL_FROM unset) to ${message.to}: ${message.subject}\n${message.text}`);
    return;
  }
  await ses().send(
    new SendEmailCommand({
      FromEmailAddress: process.env.EMAIL_FROM,
      ReplyToAddresses: [SUPPORT_EMAIL],
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            Html: { Data: message.html, Charset: "UTF-8" },
          },
        },
      },
    }),
  );
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The one layout every message uses: a heading, a few paragraphs, maybe a button. */
export function emailHtml(input: { heading: string; paragraphs: string[]; button?: { label: string; url: string } }): string {
  const paragraphs = input.paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(p)}</p>`).join("");
  const button = input.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(input.button.url)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#d9361f;color:#fff;font-weight:700;text-decoration:none">${escapeHtml(input.button.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f4ef;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f2a44">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
<p style="margin:0 0 18px;font-weight:800;font-size:18px">ReelWalk</p>
<h1 style="margin:0 0 16px;font-size:22px">${escapeHtml(input.heading)}</h1>
${paragraphs}${button}
<p style="margin:24px 0 0;font-size:13px;color:#5c6b7a">Questions? Reply to this email and it reaches a person.</p>
</div></body></html>`;
}
