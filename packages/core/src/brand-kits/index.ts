import type { BrandKit } from "../brand-kit";
import { LAST_MILE_KIT } from "./last-mile";

export { LAST_MILE_KIT };

/**
 * Kits that ship with the app as data (ADR 0078), by id. None is visible to a workspace until an admin assigns it
 * (`apps/web/scripts/brand-kit.mts assign`), which copies the kit onto that workspace's row.
 */
export const BUNDLED_BRAND_KITS: Readonly<Record<string, BrandKit>> = { [LAST_MILE_KIT.id]: LAST_MILE_KIT };
