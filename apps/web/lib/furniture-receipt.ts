import { KeyframeError } from "@reelwalk/db";
/** Only the single final image in a complete retained response is eligible. */
export function finalFurnitureImage(bytes: Buffer): Buffer {
  if (bytes.length > 34 * 1024 * 1024) throw new KeyframeError("Receipt exceeds its bound.");
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt.version !== 1 || receipt.incomplete || !Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status >= 300 || typeof receipt.bodyBase64 !== "string") throw new KeyframeError("Incomplete image receipt.");
  const body = JSON.parse(Buffer.from(receipt.bodyBase64, "base64").toString("utf8"));
  const images = (body.candidates ?? []).flatMap((c: { content?: { parts?: { thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[] } }) => c.content?.parts ?? []).filter((p: { thought?: boolean; inlineData?: { mimeType?: string; data?: string } }) => p.thought !== true && ["image/png", "image/jpeg", "image/webp"].includes(p.inlineData?.mimeType ?? "") && p.inlineData?.data);
  if (images.length !== 1) throw new KeyframeError("Exactly one final image is required.");
  const data = images[0].inlineData.data;
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new KeyframeError("Invalid image encoding.");
  const raw = Buffer.from(data, "base64");
  if (!raw.length || raw.length > 16 * 1024 * 1024) throw new KeyframeError("Invalid image size.");
  return raw;
}
