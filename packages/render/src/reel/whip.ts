import type { Clip } from "@reelwalk/core";

/** Positive amount is the arriving image; negative is the departing image. */
export function whipGeometry(amount: number, direction: Clip["whipDirection"] = "right") {
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const distance = amount === 0 ? 0 : amount * sign * 14;
  const stretch = 1 + Math.abs(amount) * 0.4;
  const blur = Math.abs(amount) * 28;
  return { x: vertical ? 0 : distance, y: vertical ? distance : 0,
    scaleX: vertical ? 1 : stretch, scaleY: vertical ? stretch : 1,
    blurX: vertical ? 0 : blur, blurY: vertical ? blur : 0 };
}
