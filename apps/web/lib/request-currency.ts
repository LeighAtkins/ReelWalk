import { cookies, headers } from "next/headers";
import { resolveCurrency, type CurrencyResolution } from "./currency";

/** The currency of the request being served (server components and server actions), ADR 0085. */
export async function requestCurrency(): Promise<CurrencyResolution> {
  const [jar, list] = await Promise.all([cookies(), headers()]);
  return resolveCurrency({ header: (name) => list.get(name), cookie: (name) => jar.get(name)?.value });
}
