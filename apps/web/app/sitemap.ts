import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** The pages a stranger can open without an account (robots.ts allows the same). */
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/pricing", "/guide", "/signup", "/login", "/privacy", "/terms", "/data-deletion"].map((path) => ({
    url: `${SITE_URL}${path === "/" ? "" : path}`,
  }));
}
