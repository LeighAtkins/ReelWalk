import { expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

it.each(["GET", "POST"])("allows signed-out bearer review %s through to token validation", method => {
  const response = proxy(new NextRequest("https://reelwalking.com/campaign-review/a-private-token", { method }));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
});

it.each(["/campaigns", "/campaigns/owner-id", "/campaign-review", "/campaign-review/token/extra"])("keeps owner or non-token route %s behind sign-in", pathname => {
  const response = proxy(new NextRequest(`https://reelwalking.com${pathname}`));
  const redirect = new URL(response.headers.get("location")!);
  expect(redirect.pathname).toBe("/login");
  expect(redirect.searchParams.get("next")).toBe(pathname);
});
