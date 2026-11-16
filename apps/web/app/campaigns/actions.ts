"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/workspace";
import { CampaignError, createCampaignReview, createListingCampaign, exportCampaignOutput, respondCampaignReview, revokeCampaignReview, updateListingCampaign } from "@/lib/listing-campaigns";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const facts = (form: FormData) => Object.fromEntries(["price", "address", "beds", "baths", "area", "contact", "openHome", "disclosure"].map((key) => [key, text(form, key)]));
const errorMessage = (error: unknown) => error instanceof CampaignError ? error.message : error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : "This action could not finish. Reload and try again.";
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);

export async function createCampaign(form: FormData) {
  const user = await getCurrentUser();
  let id: string;
  try {
    if (text(form, "verified") !== "yes") throw new CampaignError("Confirm these facts and source rights before creating a campaign.");
    const source = JSON.parse(text(form, "source")) as { id: string; revision: number };
    id = await createListingCampaign(user, { sourceReelId: source.id, sourceRevision: source.revision, title: text(form, "title"), requestKey: text(form, "requestKey"), facts: facts(form) });
  } catch (error) { return { error: errorMessage(error) }; }
  revalidatePath("/campaigns");
  redirect(`/campaigns/${id}`);
}

export async function applyCampaign(form: FormData) {
  const user = await getCurrentUser();
  const id = text(form, "campaignId");
  if (!safeId(id)) redirect("/campaigns");
  try {
    if (text(form, "verified") !== "yes") throw new CampaignError("Confirm the updated facts before applying.");
    await updateListingCampaign(user, id, { revision: Number(text(form, "revision")), requestKey: text(form, "requestKey"), reels: JSON.parse(text(form, "reels")), facts: facts(form) });
  } catch (error) { return { error: errorMessage(error) }; }
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaigns/${id}?updated=1`);
}

export async function exportCampaignCut(form: FormData) {
  const user = await getCurrentUser();
  const id = text(form, "campaignId");
  if (!safeId(id)) redirect("/campaigns");
  try { await exportCampaignOutput(user, id, text(form, "reelId"), Number(text(form, "revision")), Number(text(form, "factRevision"))); }
  catch (error) { redirect(`/campaigns/${id}?error=${encodeURIComponent(errorMessage(error))}`); }
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaigns/${id}?queued=1`);
}

export async function requestCampaignReview(form: FormData) {
  const user = await getCurrentUser();
  const id = text(form, "campaignId");
  if (!safeId(id)) redirect("/campaigns");
  let token: string;
  try { token = await createCampaignReview(user, id, text(form, "outputId"), text(form, "exportId")); }
  catch (error) { redirect(`/campaigns/${id}?error=${encodeURIComponent(errorMessage(error))}`); }
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaign-review/${token}`);
}

export async function revokeReview(form: FormData) {
  const user = await getCurrentUser();
  const id = text(form, "campaignId");
  if (!safeId(id)) redirect("/campaigns");
  await revokeCampaignReview(user, id, text(form, "reviewId"));
  revalidatePath(`/campaigns/${id}`);
  redirect(`/campaigns/${id}`);
}

export async function respondReview(form: FormData) {
  const token = text(form, "token");
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) redirect("/campaigns");
  try { await respondCampaignReview(token, { requestKey: text(form, "requestKey"), name: text(form, "name"), message: text(form, "message"), approve: text(form, "decision") === "approve" }); }
  catch (error) { redirect(`/campaign-review/${token}?error=${encodeURIComponent(errorMessage(error))}`); }
  revalidatePath(`/campaign-review/${token}`);
  redirect(`/campaign-review/${token}?saved=1`);
}
