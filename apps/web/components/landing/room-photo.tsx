"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./mocks.module.css";

/**
 * A room photo inside a drawn screen. If the file is missing (a deploy that
 * forgot public/, a renamed starter photo) the browser would show a broken
 * image glyph on a grey box; this swaps it for the app's own empty frame
 * with the room's name, so the mock still reads as a screen.
 *
 * The page is server-rendered, so the image usually fails before React is
 * attached and onError never fires: the mount check catches that case.
 */
export function RoomPhoto({
  src,
  name,
  width,
  height,
  eager = false,
}: {
  src: string;
  name: string;
  width: number;
  height: number;
  eager?: boolean;
}) {
  const [missing, setMissing] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setMissing(true);
  }, []);

  return (
    <span className={styles.photo} data-missing={missing || undefined}>
      {missing ? (
        <span className={styles.photoName}>{name}</span>
      ) : (
        <img
          ref={ref}
          src={src}
          alt=""
          width={width}
          height={height}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setMissing(true)}
        />
      )}
    </span>
  );
}
