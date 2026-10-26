import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner: "I think the current font is unreadable. We want people to read." (ADR 0085). These
 * measure the public pages' type instead of eyeballing it: WCAG contrast of the text tokens on their
 * grounds, and the sizes, weights and line heights in the stylesheets the landing, pricing, sign-up
 * and account pages use.
 */
const web = join(__dirname, "..");
const globals = readFileSync(join(web, "app/globals.css"), "utf8");
const landing = readFileSync(join(web, "components/landing/landing.module.css"), "utf8");

function token(name: string): string {
  const match = globals.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`no --${name} in globals.css`);
  return match[1]!;
}

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Every rule of a stylesheet: selector and its declarations (flat; @media blocks are read through). */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)) out.push({ selector: match[1]!.trim(), body: match[2]! });
  return out;
}

const px = (body: string, prop: string): number | null => {
  const value = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) return null;
  // clamp(min, preferred, max): the smallest it can be is what a phone gets.
  const clamp = value.match(/^clamp\(\s*([\d.]+)px/);
  if (clamp) return Number(clamp[1]);
  const plain = value.match(/^([\d.]+)px$/);
  return plain ? Number(plain[1]) : null;
};

describe("text contrast on the public pages (WCAG AA, 4.5:1)", () => {
  const grounds = { ink: token("ink"), "ink-deep": token("ink-deep") };
  for (const text of ["paper", "muted"]) {
    for (const [ground, hex] of Object.entries(grounds)) {
      it(`--${text} on --${ground}`, () => {
        expect(contrast(token(text), hex)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("the primary button's dark text on ivory", () => {
    expect(contrast(token("ink"), token("paper"))).toBeGreaterThanOrEqual(4.5);
  });

  it("measures known pairs correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe("type sizes on the landing and pricing pages", () => {
  const sized = rules(landing).filter((rule) => px(rule.body, "font-size") !== null);
  // The only text allowed under 16px: small print, at 15px.
  const SMALL_PRINT = [".fine", ".samplesCaption", ".per", ".smallPrint"];

  it("no text below 15px, and only small print below 16px", () => {
    for (const rule of sized) {
      const size = px(rule.body, "font-size")!;
      expect(size, rule.selector).toBeGreaterThanOrEqual(15);
      if (size < 16) expect(SMALL_PRINT, `${rule.selector} is ${size}px`).toContain(rule.selector);
    }
  });

  it("display headings are at least 22px and 500 to 600 weight", () => {
    const headings = rules(landing).filter((rule) => /\bh[1-3]\b|\.amount|\.askList/.test(rule.selector) && px(rule.body, "font-size") !== null);
    expect(headings.length).toBeGreaterThan(3);
    for (const rule of headings) {
      if (!/var\(--display\)/.test(rule.body) && !/\.main h2|\.hero h1/.test(rule.selector)) continue;
      expect(px(rule.body, "font-size")!, rule.selector).toBeGreaterThanOrEqual(22);
      const weight = Number(rule.body.match(/font-weight:\s*(\d+)/)?.[1] ?? 600);
      expect(weight, rule.selector).toBeGreaterThanOrEqual(500);
      expect(weight, rule.selector).toBeLessThanOrEqual(600);
    }
  });

  it("paragraphs breathe: line-height 1.45 or more", () => {
    for (const selector of [".lede", ".step p", ".timeNote", ".factList", ".faq p", ".features"]) {
      const rule = rules(landing).find((candidate) => candidate.selector === selector);
      const height = Number(rule?.body.match(/line-height:\s*([\d.]+);/)?.[1]);
      expect(height, selector).toBeGreaterThanOrEqual(1.45);
    }
  });
});

describe("the app's shared type", () => {
  // globals.css has an unclosed `.hook-drawn > summary {` (since #214) that nests every later rule under it, so
  // nothing after it applies. Closing it switches on ~400 lines no one has seen in production and is its own
  // change; until then this branch's rules must sit before it, at the top level.
  it("the reading and currency rules are at the top level, not swallowed by an unclosed block", () => {
    const clean = globals.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[{}]/g, " "));
    const depthAt = (needle: string) => {
      const end = clean.indexOf(needle);
      expect(end, needle).toBeGreaterThan(0);
      let depth = 0;
      for (const ch of clean.slice(0, end)) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      return depth;
    };
    expect(depthAt(".auth,\n.readable {")).toBe(0);
    expect(depthAt('[data-currency="aud"] [data-cur="usd"]')).toBe(0);
  });

  it("the display face is Playfair Display, not the hairline Bodoni", () => {
    expect(globals).toMatch(/--display:\s*"Playfair Display Variable"/);
    expect(globals).not.toMatch(/Bodoni Moda/);
  });

  it("display headings are never below 22px", () => {
    for (const selector of ["h1", "h2", ".card h2", ".brand"]) {
      const rule = rules(globals).find((candidate) => candidate.selector === selector && px(candidate.body, "font-size") !== null);
      expect(px(rule!.body, "font-size")!, selector).toBeGreaterThanOrEqual(22);
    }
  });

  it("body is 16px at 1.5, and sign-up and account small print is 15px", () => {
    const body = rules(globals).find((rule) => rule.selector === "body")!;
    expect(px(body.body, "font-size")).toBe(16);
    expect(Number(body.body.match(/line-height:\s*([\d.]+)/)?.[1])).toBeGreaterThanOrEqual(1.45);
    const small = rules(globals).find((rule) => rule.selector.includes(".auth .small"))!;
    expect(px(small.body, "font-size")).toBe(15);
  });
});
