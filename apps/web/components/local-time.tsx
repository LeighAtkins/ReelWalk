"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";

const local = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * A date in the viewer's own time zone. The server renders it in UTC (it
 * does not know the zone), and the browser swaps in local time on load.
 */
export function LocalTime({ date }: { date: Date }) {
  const [text, setText] = useState(() => formatDateTime(date));
  useEffect(() => setText(local.format(date)), [date]);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}
