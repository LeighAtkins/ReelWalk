import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * The server env that billing and the landing page read, typed in one place (ADR 0088).
 *
 * Every variable here is optional, because each one's absence already has a meaning: no Stripe keys
 * and billing is off; no US$ prices and only A$ is sold; no yearly price and the yearly option hides;
 * no SAMPLE_REEL_URL and the landing page draws a placeholder; no APP_URL and links take the request's
 * host. A missing variable must never stop the server booting, so nothing is required.
 *
 * Terraform stores an absent secret as the literal "unset" (Parameter Store refuses empty values), and an
 * empty string is absent too: both read as undefined here, exactly as the old `isSet` checks did.
 *
 * Values are read from process.env when used, not once at import, so a test (or a value changed on a
 * running process) sees the current value, as the direct process.env reads this replaces did.
 */
const optional = z.string().optional();

const server = {
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  // A$ plan prices (ADR 0081): the monthly ones turn billing on; a missing yearly one hides yearly.
  STRIPE_PRICE_AGENT_MONTHLY: optional,
  STRIPE_PRICE_AGENT_YEARLY: optional,
  STRIPE_PRICE_OFFICE_MONTHLY: optional,
  STRIPE_PRICE_OFFICE_YEARLY: optional,
  // US$ plan prices (ADR 0085): US$ is sold once both monthly ones are set.
  STRIPE_PRICE_AGENT_MONTHLY_USD: optional,
  STRIPE_PRICE_AGENT_YEARLY_USD: optional,
  STRIPE_PRICE_OFFICE_MONTHLY_USD: optional,
  STRIPE_PRICE_OFFICE_YEARLY_USD: optional,
  // The 10-credit top-up; unset hides the button in that currency.
  STRIPE_PRICE_AI_TOP_UP: optional,
  STRIPE_PRICE_AI_TOP_UP_USD: optional,
  // Products, so a price from before a currency swap still resolves to its plan.
  STRIPE_PRODUCT_AGENT: optional,
  STRIPE_PRODUCT_OFFICE: optional,
  // Landing page samples (comma-separated, positions kept; see lib/sample-reels.ts).
  SAMPLE_REEL_URL: optional,
  SAMPLE_REEL_POSTER_URL: optional,
  SAMPLE_REEL_LABELS: optional,
  SAMPLE_REEL_RAW_URLS: optional,
  APP_URL: optional,
};

export type ServerEnv = { [K in keyof typeof server]: string | undefined };
export type ServerEnvName = keyof ServerEnv;

const NAMES = Object.keys(server) as ServerEnvName[];

/** Absent, empty and Terraform's "unset" all mean the same thing: not set. */
export function present(value: string | undefined): string | undefined {
  return value && value !== "unset" ? value : undefined;
}

/**
 * Parses the billing/landing env from a source (process.env by default). Validation is skipped in tests
 * and e2e (NODE_ENV=test or SKIP_ENV_VALIDATION); "unset" is cleared before parsing so it reads as
 * absent either way.
 */
export function parseServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  // A copy: emptyStringAsUndefined deletes keys from the object it is given.
  const runtimeEnv = Object.fromEntries(NAMES.map((name) => [name, present(source[name])])) as Record<ServerEnvName, string | undefined>;
  return createEnv({
    server,
    runtimeEnv,
    emptyStringAsUndefined: true,
    skipValidation: Boolean(source.SKIP_ENV_VALIDATION) || source.NODE_ENV === "test",
  }) as ServerEnv;
}

let cached: { key: string; env: ServerEnv } | null = null;

/** The current env, re-parsed only when one of its variables changed. */
function current(): ServerEnv {
  const key = NAMES.map((name) => process.env[name] ?? "\u0000").join("\u0001");
  if (cached?.key !== key) cached = { key, env: parseServerEnv(process.env) };
  return cached.env;
}

/** `env.STRIPE_SECRET_KEY` etc.: undefined when absent, empty or "unset". */
export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get: (_, name) => (typeof name === "string" ? current()[name as ServerEnvName] : undefined),
});

/**
 * Values that are set but do not look like what they should be: a price id that is not `price_…`, a
 * webhook secret that is not `whsec_…`. Logged once at boot as a warning, never fatal: a value that
 * works today keeps working.
 */
export function envWarnings(values: ServerEnv = current()): string[] {
  const shape: [RegExp, string][] = [
    [/^STRIPE_PRICE_/, "price_"],
    [/^STRIPE_PRODUCT_/, "prod_"],
    [/^STRIPE_WEBHOOK_SECRET$/, "whsec_"],
    [/^STRIPE_SECRET_KEY$/, "sk_|rk_"],
  ];
  const warnings: string[] = [];
  for (const name of NAMES) {
    const value = values[name];
    if (!value) continue;
    const rule = shape.find(([pattern]) => pattern.test(name));
    if (rule && !rule[1].split("|").some((prefix) => value.startsWith(prefix))) warnings.push(`${name} does not start with ${rule[1].replace("|", " or ")}`);
    if (name === "APP_URL" && !/^https?:\/\//.test(value)) warnings.push("APP_URL does not start with http:// or https://");
  }
  return warnings;
}
