"use client";

import { useEffect, useRef, useState } from "react";
import type { Currency } from "@reelwalk/core";
import { CURRENCY_COOKIE } from "@/lib/currency";

/**
 * "Prices in AUD · USD": a quiet switch on the pricing section (ADR 0085). The
 * pick is a year-long cookie that beats every other evidence, so checkout
 * charges the currency the visitor chose; the shown prices change at once by
 * flipping the enclosing scope's `data-currency`.
 */
export function CurrencyToggle({ initial, className }: { initial: Currency; className?: string }) {
  const [currency, setCurrency] = useState<Currency>(initial);
  const ref = useRef<HTMLParagraphElement>(null);
  const scope = () => ref.current?.closest<HTMLElement>("[data-currency]") ?? null;

  // The inline snippet may have placed the visitor before hydration.
  useEffect(() => {
    const shown = scope()?.dataset.currency;
    if (shown === "aud" || shown === "usd") setCurrency(shown);
  }, []);

  function pick(next: Currency) {
    document.cookie = `${CURRENCY_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    scope()?.setAttribute("data-currency", next);
    setCurrency(next);
  }

  return (
    <p ref={ref} className={className} data-testid="currency-toggle">
      <span>Prices in</span>
      {(["aud", "usd"] as const).map((option, index) => (
        <span key={option}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <button type="button" aria-pressed={currency === option} onClick={() => pick(option)} data-testid={`currency-${option}`}>
            {option.toUpperCase()}
          </button>
        </span>
      ))}
    </p>
  );
}
