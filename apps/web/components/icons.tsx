import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A 9:16 frame with a play head: the reel itself. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 18 32" aria-hidden="true">
      <rect width="18" height="32" rx="4" fill="currentColor" />
      <path d="M6.5 11.5v9l7-4.5Z" fill="#fff" />
    </svg>
  );
}

export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M19 12H5m6-6-6 6 6 6" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 4v11m-5-4 5 5 5-5M5 20h14" />
  </Icon>
);

export const FilmIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon>
    <path d="M12 16V5m-5 4 5-5 5 5M5 20h14" />
  </Icon>
);
