import { headers } from "next/headers";
import { isEmailConfigured } from "./email";

/**
 * The address the outside world reaches this app on. APP_URL when the
 * deployment sets it; otherwise the address of the current request, which is
 * what a phone on the same Wi-Fi used, so links copied there keep working.
 */
export async function appUrl(): Promise<string> {
  // An emailed link must not take its host from the request: anyone can send
  // a Host header, and the person who opens the link cannot tell.
  if (isEmailConfigured() && !process.env.APP_URL) {
    throw new Error("APP_URL must be set when EMAIL_FROM is set: emailed links would otherwise take their host from the request");
  }
  const configured = process.env.APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || /^\d+\.\d+\.\d+\.\d+/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
