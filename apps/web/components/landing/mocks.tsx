import Image from "next/image";
import {
  BackIcon,
  CaptionIcon,
  CloseIcon,
  DownloadIcon,
  GuidesIcon,
  MusicIcon,
  PlayIcon,
  PlusIcon,
  RedoIcon,
  ShareIcon,
  SplitIcon,
  TextIcon,
  UndoIcon,
} from "@/components/icons";
import styles from "./mocks.module.css";

/**
 * The app's screens, drawn in HTML for the landing page: the media sheet,
 * the editor, the export screen and the share screen, each with real room
 * photos from the starter library in it. They copy the real screens'
 * layout and colours (globals.css) so the page shows what the product
 * looks like, not an artist's impression. One listing runs through all four.
 */

const LISTING = {
  title: "14 Harbour Lane",
  price: "$1,250,000",
  facts: ["4 bed", "3 bath", "2,900 sq ft"],
  address: "14 Harbour Lane, Newport",
  contact: "Harbour Lane Photo",
};

/** Rooms of the one listing, in the order the photographer tapped them. */
const ROOMS = [
  { file: "lounge-garden", name: "Garden lounge", pano: true },
  { file: "kitchen-view", name: "Kitchen", pano: true },
  { file: "suite", name: "Main suite", pano: false },
  { file: "bathroom", name: "Bathroom", pano: false },
  { file: "veranda", name: "Veranda", pano: true },
  { file: "deck", name: "Deck", pano: false },
  { file: "lounge-window", name: "Sitting room", pano: false },
  { file: "glasshouse", name: "Guest room", pano: true },
  { file: "dining", name: "Dining room", pano: false },
  { file: "bedroom", name: "Second bedroom", pano: false },
] as const;

type Room = (typeof ROOMS)[number];

function roomSrc(room: Room, small = false): string {
  return `/landing/${room.file}${small ? "-s" : ""}.jpg`;
}

/** A phone, 9:19.5, with the app's dark ground inside. */
function Phone({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <figure className={styles.phone} role="img" aria-label={label}>
      <div className={styles.screen}>{children}</div>
    </figure>
  );
}

/* ── 1. Add photos and videos ───────────────────────────────────── */

export function MediaSheetMock() {
  const picked = ROOMS.slice(0, 5);
  return (
    <Phone label="The Add photos and videos sheet in ReelWalk, with five rooms tapped in order">
      <div className={styles.topbar}>
        <span className={styles.iconBtn}>
          <CloseIcon size={18} />
        </span>
        <span className={styles.titleBlock}>
          <span className={styles.title}>{LISTING.title}</span>
          <span className={styles.saveState}>Saved</span>
        </span>
        <span className={`${styles.pill} ${styles.pillSignal} ${styles.pillDim}`}>Export</span>
      </div>
      <div className={styles.sheet}>
        <span className={styles.sheetHandle} />
        <div className={styles.sheetHead}>
          <span className={styles.sheetTitle}>Add photos and videos</span>
          <CloseIcon size={18} />
        </div>
        <span className={`${styles.pill} ${styles.pillSignal} ${styles.pillBlock}`}>
          <PlusIcon size={16} />
          Choose from your phone
        </span>
        <p className={styles.sheetNote}>Or pick from your library. Tap in the order you want them.</p>
        <div className={styles.chips}>
          <span className={`${styles.chip} ${styles.chipOn}`}>All</span>
          <span className={styles.chip}>360 photos</span>
          <span className={styles.chip}>Videos</span>
          <span className={styles.chip}>Photos</span>
        </div>
        <ul className={styles.library}>
          {ROOMS.slice(0, 9).map((room) => {
            const order = picked.indexOf(room);
            return (
              <li key={room.file} className={styles.libraryItem} data-picked={order >= 0}>
                <Image src={roomSrc(room, true)} alt="" width={270} height={480} sizes="96px" unoptimized />
                {room.pano ? <span className={styles.tag}>360</span> : null}
                {order >= 0 ? <span className={styles.order}>{order + 1}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Phone>
  );
}

/* ── 2. The editor ──────────────────────────────────────────────── */

const TOOLS = [
  { icon: <PlusIcon size={20} />, name: "Add media" },
  { icon: <TextIcon size={20} />, name: "Text" },
  { icon: <MusicIcon size={20} />, name: "Music" },
  { icon: <SplitIcon size={20} />, name: "Split" },
  { icon: <CaptionIcon size={20} />, name: "Caption" },
  { icon: <GuidesIcon size={20} />, name: "Guides" },
];

/** The timeline's scale: pixels per second of the reel, at the editor's default zoom. */
const PPS = 64;

/** Clips on the timeline, in seconds, each cut on a beat of the song. */
const CLIPS = [
  { room: ROOMS[0], start: 0, length: 4 },
  { room: ROOMS[1], start: 4, length: 2 },
  { room: ROOMS[2], start: 6, length: 2 },
  { room: ROOMS[3], start: 8, length: 2 },
  { room: ROOMS[4], start: 10, length: 4 },
];

export function EditorMock() {
  const playhead = 6.7;
  const onScreen = ROOMS[2];
  const windowStart = playhead - 2.8; // the second shown at the timeline's left edge
  return (
    <Phone label="The ReelWalk editor: the main suite on screen with the price card, and a timeline of five rooms, a text and a song">
      <div className={styles.topbar}>
        <span className={styles.iconBtn}>
          <CloseIcon size={18} />
        </span>
        <span className={styles.titleBlock}>
          <span className={styles.title}>{LISTING.title}</span>
          <span className={styles.saveState}>Saved</span>
        </span>
        <span className={`${styles.pill} ${styles.pillSignal}`}>Export</span>
      </div>
      <div className={styles.stage}>
        <div className={styles.frame}>
          <Image src={roomSrc(onScreen)} alt="" width={900} height={1600} sizes="(min-width: 880px) 220px, 60vw" unoptimized />
          <span className={styles.label}>{onScreen.name}</span>
          <DetailsCard />
        </div>
      </div>
      <div className={styles.transport}>
        <PlayIcon size={18} />
        <span className={styles.clock}>
          0:06.7 <span className={styles.clockTotal}>/ 0:14.0</span>
        </span>
        <span className={styles.transportEnd}>
          <UndoIcon size={18} />
          <span className={styles.dim}>
            <RedoIcon size={18} />
          </span>
        </span>
      </div>
      <div className={styles.timeline} style={{ "--pps": `${PPS}px`, "--offset": `${-windowStart * PPS}px` } as React.CSSProperties}>
        <div className={styles.ruler}>
          {[4, 5, 6, 7, 8, 9].map((second) => (
            <span key={second} style={{ left: `calc(${second}s * var(--pps) / 1s + var(--offset))` }}>
              {second}s
            </span>
          ))}
        </div>
        <div className={styles.laneClips}>
          {CLIPS.map((clip) => (
            <span
              key={clip.room.file}
              className={styles.clipBlock}
              data-selected={clip.room === onScreen}
              style={{
                left: `calc(${clip.start} * var(--pps) + var(--offset))`,
                width: `calc(${clip.length} * var(--pps) - 3px)`,
                backgroundImage: `url(${roomSrc(clip.room, true)})`,
              }}
            >
              <span className={styles.clipTime}>
                {clip.room.pano ? "360 " : ""}0:0{clip.length}.0
              </span>
            </span>
          ))}
        </div>
        <div className={styles.lane}>
          <span className={`${styles.bar} ${styles.barText}`} style={{ left: `calc(6 * var(--pps) + var(--offset))`, width: `calc(2 * var(--pps) - 3px)` }}>
            <TextIcon size={12} />
            {onScreen.name}
          </span>
        </div>
        <div className={styles.lane}>
          <span className={`${styles.bar} ${styles.barMusic}`} style={{ left: `var(--offset)`, width: `calc(14 * var(--pps))` }}>
            <MusicIcon size={12} />
            Carefree
          </span>
        </div>
        <span className={styles.playhead} style={{ left: `calc(${playhead} * var(--pps) + var(--offset))` }} />
      </div>
      <div className={styles.toolbar}>
        {TOOLS.map((tool) => (
          <span key={tool.name} className={styles.tool}>
            {tool.icon}
            {tool.name}
          </span>
        ))}
      </div>
    </Phone>
  );
}

/** The listing details card the renderer draws: price, facts, address, who to call. */
function DetailsCard() {
  return (
    <span className={styles.details}>
      <strong>{LISTING.price}</strong>
      <span className={styles.facts}>
        {LISTING.facts.map((fact, index) => (
          <span key={fact}>
            {index > 0 ? <i /> : null}
            {fact}
          </span>
        ))}
      </span>
      <span className={styles.address}>{LISTING.address}</span>
      <span className={styles.contact}>{LISTING.contact}</span>
    </span>
  );
}

/* ── 3. Rendering ───────────────────────────────────────────────── */

export function ExportMock() {
  const percent = 64;
  return (
    <Phone label={`The export screen in ReelWalk: ${percent} percent rendered at 1080 by 1920`}>
      <div className={styles.exportTop}>
        <span className={`${styles.pill} ${styles.pillQuiet}`}>
          <BackIcon size={16} />
          Edit
        </span>
        <span className={styles.exportName}>{LISTING.title}</span>
      </div>
      <div className={styles.exportBody}>
        <div className={`${styles.frame} ${styles.exportFrame}`}>
          <Image src={roomSrc(ROOMS[0])} alt="" width={900} height={1600} sizes="(min-width: 880px) 220px, 60vw" unoptimized />
          <span className={styles.exportFill} style={{ height: `${percent}%` }} />
          <span className={styles.exportFigure}>
            <strong>{percent}%</strong>
            Rendering 1080×1920
          </span>
        </div>
        <p className={styles.exportNote}>You can leave this screen. The export keeps going and appears under Exports.</p>
      </div>
    </Phone>
  );
}

/* ── 4. Ready for Instagram ─────────────────────────────────────── */

export function ShareMock() {
  return (
    <Phone label="The finished reel in ReelWalk, with Share to Instagram, Download and a post caption">
      <div className={styles.exportTop}>
        <span className={`${styles.pill} ${styles.pillQuiet}`}>
          <BackIcon size={16} />
          Edit
        </span>
        <span className={styles.exportName}>{LISTING.title}</span>
      </div>
      <div className={styles.exportBody}>
        <div className={`${styles.frame} ${styles.shareFrame}`}>
          <Image src={roomSrc(ROOMS[4])} alt="" width={900} height={1600} sizes="(min-width: 880px) 160px, 44vw" unoptimized />
          <DetailsCard />
        </div>
        <div className={styles.shareText}>
          <span className={styles.shareTitle}>Ready for Instagram</span>
          <span className={styles.shareSub}>1080×1920 MP4, 30 fps. Share it to Instagram from your phone, or download it.</span>
        </div>
        <span className={`${styles.pill} ${styles.pillSignal} ${styles.pillBlock}`}>
          <ShareIcon size={16} />
          Share to Instagram
        </span>
        <div className={styles.shareRow}>
          <span className={`${styles.pill} ${styles.pillQuiet} ${styles.pillBlock}`}>
            <DownloadIcon size={16} />
            Download
          </span>
          <span className={`${styles.pill} ${styles.pillQuiet} ${styles.pillBlock}`}>Keep editing</span>
        </div>
        <div className={styles.captionBox}>
          <span className={styles.captionHead}>
            Post caption <span>118/2200</span>
          </span>
          <span className={styles.captionText}>
            Just listed: {LISTING.address}. 4 bed, 3 bath, open Saturday 11 to 1. Call Harbour Lane Photo for the link. #justlisted #newport
          </span>
        </div>
      </div>
    </Phone>
  );
}
