import type { MetadataRoute } from "next";

/** The landing page, plans, sign-in and sign-up may be indexed; studios, reels and the API may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // "/$" is the landing page alone; everything else under / stays out unless listed.
        allow: ["/$", "/pricing", "/login", "/signup", "/privacy", "/terms", "/data-deletion"],
        disallow: ["/"],
      },
    ],
  };
}
