import type { ReactNode } from "react";

function Icon({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

/** A 9:16 frame on a drafting grid: the reel, drawn like a plan. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 32" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="29" rx="3" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M1.5 12h11v18.5M12.5 12V1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15 17.5v7l5.5-3.5Z" fill="#f0442c" />
    </svg>
  );
}

export const PlusIcon = ({ size }: IconProps) => <Icon size={size}><path d="M12 5v14M5 12h14" /></Icon>;
export const TextIcon = ({ size }: IconProps) => <Icon size={size}><path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" /></Icon>;
export const MusicIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </Icon>
);
export const SplitIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3v18" />
    <path d="M4 7h5v10H4zM15 7h5v10h-5z" />
  </Icon>
);
export const TrimIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M8 4H5v16h3M16 4h3v16h-3" />
    <path d="M9.5 12h5" />
  </Icon>
);
export const SpeedIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4.5 17a8 8 0 1 1 15 0" />
    <path d="m12 13 4-5" />
  </Icon>
);
export const VolumeIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 9h4l5-4v14l-5-4H4z" />
    <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
  </Icon>
);
export const MuteIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 9h4l5-4v14l-5-4H4z" />
    <path d="m17 10 4 4M21 10l-4 4" />
  </Icon>
);
export const FitIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="6" y="2.5" width="12" height="19" rx="2" />
    <path d="M9 9h6v6H9z" />
  </Icon>
);
export const FilterIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="9" cy="10" r="5" />
    <circle cx="15" cy="10" r="5" />
    <circle cx="12" cy="15" r="5" />
  </Icon>
);
export const DetailsIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 5.5h16v13H4z" />
    <path d="M7.5 10h5M7.5 14h9" />
    <circle cx="16.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);
export const PlanIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.5 4.5h17v15h-17z" />
    <path d="M3.5 11h7M10.5 4.5V14M14 19.5v-6h6.5" />
    <circle cx="16.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);
export const PanoIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
    <path d="M3.5 12h17" />
  </Icon>
);
export const MotionIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <rect x="8" y="8" width="8" height="8" rx="1" />
    <path d="M3 3l5 5M21 3l-5 5M3 21l5-5M21 21l-5-5" />
  </Icon>
);
export const TransitionIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="2.5" y="6" width="11" height="12" rx="1.5" />
    <rect x="10.5" y="6" width="11" height="12" rx="1.5" />
  </Icon>
);
export const DuplicateIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </Icon>
);
export const MoveLeftIcon = ({ size }: IconProps) => <Icon size={size}><path d="M11 6 5 12l6 6M5 12h14" /></Icon>;
export const MoveRightIcon = ({ size }: IconProps) => <Icon size={size}><path d="m13 6 6 6-6 6M19 12H5" /></Icon>;
export const TrashIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Icon>
);
export const UndoIcon = ({ size }: IconProps) => <Icon size={size}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Icon>;
export const RedoIcon = ({ size }: IconProps) => <Icon size={size}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Icon>;
export const PlayIcon = ({ size }: IconProps) => (
  <svg className="icon" width={size ?? 22} height={size ?? 22} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5Z" fill="currentColor" />
  </svg>
);
export const PauseIcon = ({ size }: IconProps) => (
  <svg className="icon" width={size ?? 22} height={size ?? 22} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" />
  </svg>
);
export const CloseIcon = ({ size }: IconProps) => <Icon size={size}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const BackIcon = ({ size }: IconProps) => <Icon size={size}><path d="M15 5l-7 7 7 7" /></Icon>;
export const CheckIcon = ({ size }: IconProps) => <Icon size={size}><path d="m5 12.5 4.5 4.5L19 7" /></Icon>;
export const DownloadIcon = ({ size }: IconProps) => <Icon size={size}><path d="M12 4v11M7 10.5 12 15.5l5-5M5 20h14" /></Icon>;
export const ShareIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" />
    <path d="M6 11H5v9.5h14V11h-1" />
  </Icon>
);
export const InstagramIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <circle cx="12" cy="12" r="3.8" />
    <circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);
export const LinkIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
  </Icon>
);
export const AccountIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
);
export const CopyIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </Icon>
);
export const GuidesIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="5" y="2.5" width="14" height="19" rx="2" />
    <path d="M5 6h14M5 16h14M16.5 6v10" strokeDasharray="2 2" />
  </Icon>
);
export const CaptionIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12.5h5" />
  </Icon>
);
export const ReelsIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
    <path d="M10.5 9.5v5l4-2.5z" />
  </Icon>
);
export const ExportsIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3v10M8 9l4 4 4-4" />
    <path d="M4 15v4.5h16V15" />
  </Icon>
);
export const SwapIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Icon>
);
export const EditIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </Icon>
);
export const ClockIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
export const AlertIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3.5 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </Icon>
);
