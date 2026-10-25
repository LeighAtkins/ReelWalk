import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** The landing page, plans, sign-in and sign-up may be indexed; studios, reels and the API may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // "/$" is the landing page alone; everything else under / stays out unless listed.
        allow: ["/$", "/pricing", "/login", "/signup", "/guide", "/privacy", "/terms", "/data-deletion"],
        disallow: ["/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
