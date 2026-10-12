"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@reelwalk/db";
import { emailHtml, sendEmail, SUPPORT_EMAIL } from "@/lib/email";
import { workspacePlan } from "@/lib/plans";
import { getCurrentUser } from "@/lib/workspace";

/** Only same-site paths are kept as "the page they were on" or used to go back. */
function safePath(value: unknown): string | null {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") && path.length <= 300 ? path : null;
}

const feedbackSchema = z.object({
  message: z.string().trim().min(1, "Write a line or two first.").max(4000, "Keep it under 4000 characters."),
  contactOk: z.boolean(),
  page: z.string().nullable(),
  back: z.string().nullable(),
});

/**
 * Stores the note and emails it to the support address with who sent it,
 * their plan and the screen they were on (ADR 0016). The row is written
 * first, so a mail failure loses nothing.
 */
export async function sendFeedback(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const parsed = feedbackSchema.safeParse({
    message: formData.get("message"),
    contactOk: formData.get("contactOk") === "yes",
    page: safePath(formData.get("page")),
    back: safePath(formData.get("back")),
  });
  const back = safePath(formData.get("back")) ?? "/feedback";
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form";
    redirect(withQuery(back, { feedback: "error", message }));
  }
  const { message, contactOk, page } = parsed.data;

  const { plan } = await workspacePlan(user.workspaceId);
  await prisma.feedback.create({ data: { workspaceId: user.workspaceId, userId: user.id, message, page, contactOk } });

  const facts = [
    `From: ${user.name} <${user.email}>`,
    `Studio: ${user.workspace.name} (${user.workspaceId})`,
    `Plan: ${plan.name}`,
    `Page: ${page ?? "unknown"}`,
    `May we reply: ${contactOk ? "yes" : "no"}`,
  ];
  try {
    await sendEmail({
      to: SUPPORT_EMAIL,
      subject: `Feedback from ${user.email} (${plan.name})`,
      text: [...facts, "", message].join("\n"),
      html: emailHtml({ heading: "Feedback from the app", paragraphs: [...facts, message] }),
    });
  } catch (error) {
    console.error("feedback: email failed; the row is stored", error);
  }
  redirect(withQuery(back, { feedback: "sent" }));
}

function withQuery(path: string, params: Record<string, string>): string {
  const [pathname, hash] = path.split("#");
  const url = new URL(pathname!, "http://x");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`;
}
