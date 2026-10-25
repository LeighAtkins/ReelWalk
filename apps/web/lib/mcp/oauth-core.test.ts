import { describe, expect, it } from "vitest";
import { challengeFor, hashSecret, isAllowedRedirectUri, isCodeChallenge, isOurResource, newSecret, redirectUriMatches, resourceFor, verifyPkce, withParams } from "./oauth-core";

describe("PKCE (S256)", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 appendix B
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches the RFC 7636 example", () => {
    expect(challengeFor(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("refuses a wrong, short or missing verifier", () => {
    expect(verifyPkce("x".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("short", challengeFor("short"))).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce("bad verifier with spaces ".repeat(3), challenge)).toBe(false);
  });

  it("only accepts a 43-character base64url challenge", () => {
    expect(isCodeChallenge(challenge)).toBe(true);
    expect(isCodeChallenge("abc")).toBe(false);
    expect(isCodeChallenge(undefined)).toBe(false);
    expect(isCodeChallenge(`${challenge}=`)).toBe(false);
  });
});

describe("secrets", () => {
  it("are prefixed, random and stored only as a hash", () => {
    const a = newSecret("rwa");
    const b = newSecret("rwa");
    expect(a).toMatch(/^rwa_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(a)).not.toContain(a);
    expect(newSecret("rwr").startsWith("rwr_")).toBe(true);
  });
});

describe("redirect URIs", () => {
  it("allows https, loopback http and custom schemes", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/cb")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
  });

  it("refuses plain http elsewhere, fragments, credentials and script schemes", () => {
    expect(isAllowedRedirectUri("http://example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://example.com/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("https://user:pw@example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,x")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("matches exactly, except a loopback port", () => {
    const registered = ["https://claude.ai/cb", "http://localhost:3000/cb"];
    expect(redirectUriMatches(registered, "https://claude.ai/cb")).toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai/cb/")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:51234/cb")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:51234/other")).toBe(false);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example:8443/cb")).toBe(false);
  });

  it("adds response parameters to the app's own URI", () => {
    expect(withParams("https://claude.ai/cb?x=1", { code: "abc", state: "s s", iss: undefined })).toBe("https://claude.ai/cb?x=1&code=abc&state=s+s");
  });
});

describe("resource indicator", () => {
  it("is the /mcp URL of the site, with or without a trailing slash", () => {
    expect(resourceFor("https://reelwalking.com")).toBe("https://reelwalking.com/mcp");
    expect(isOurResource("https://reelwalking.com/mcp", "https://reelwalking.com")).toBe(true);
    expect(isOurResource("https://reelwalking.com/mcp/", "https://reelwalking.com")).toBe(true);
    expect(isOurResource(undefined, "https://reelwalking.com")).toBe(true);
    expect(isOurResource("https://evil.example/mcp", "https://reelwalking.com")).toBe(false);
    expect(isOurResource("https://reelwalking.com/api", "https://reelwalking.com")).toBe(false);
  });
});
