import type { MetadataRoute } from "next";

/** Sign-in and sign-up may be indexed; studios, reels and the API may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/login", "/signup", "/privacy", "/terms", "/data-deletion"], disallow: ["/"] }],
  };
}
