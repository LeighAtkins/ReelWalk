import type { ReactNode } from "react";
import type { Currency } from "@reelwalk/core";
import { COUNTRY_SNIPPET, type CurrencyResolution } from "@/lib/currency";

/**
 * A part of a page whose prices follow the visitor's currency (ADR 0085). The
 * server writes the currency it resolved on `data-currency`; prices inside are
 * written in both currencies (`InCurrency`) and globals.css shows the one the
 * scope names, so the toggle switches without a round trip. When the server
 * had no evidence at all (a first visit with no CDN country header), the
 * inline snippet places the visitor from the time zone and languages and
 * corrects `data-currency` before anything below it paints: no flash of the
 * wrong prices. With only one currency on sale the scope is fixed to it.
 */
export function CurrencyScope({
  resolution,
  offered,
  className,
  children,
}: {
  resolution: CurrencyResolution;
  offered: Currency[];
  className?: string;
  children: ReactNode;
}) {
  const fixed = offered.length === 1 ? offered[0]! : null;
  return (
    <div
      className={className}
      data-currency={fixed ?? resolution.currency}
      data-currency-source={fixed ? "fixed" : resolution.source}
      // The snippet may change data-currency before React hydrates.
      suppressHydrationWarning
    >
      <script dangerouslySetInnerHTML={{ __html: COUNTRY_SNIPPET }} />
      {children}
    </div>
  );
}

/** The same words in each currency; only the scope's currency shows. */
export function InCurrency({ aud, usd }: { aud: ReactNode; usd: ReactNode }) {
  return (
    <>
      <span data-cur="aud">{aud}</span>
      <span data-cur="usd">{usd}</span>
    </>
  );
}
