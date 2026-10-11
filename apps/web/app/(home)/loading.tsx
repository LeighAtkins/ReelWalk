import { BrandMark, DishIcon, PanoIcon, PlusIcon } from "@/components/icons";
import { TabBar } from "@/components/tab-bar";

/** The home page while its reels load: the same frame, so nothing jumps when they arrive. */
export default function Loading() {
  return (
    <>
      <main className="shell shell-home" aria-busy="true">
        <header className="shell-head">
          <span className="brand">
            <BrandMark />
            ReelWalk
          </span>
        </header>
        <h1 className="home-title">Reels</h1>
        <div className="start" aria-hidden="true">
          <div className="start-primary start-placeholder">
            <span className="viewfinder">
              <PlusIcon size={22} />
            </span>
            <span className="start-text">
              <span className="start-title">New reel</span>
              <span className="start-sub">Pick photos and videos from your phone</span>
            </span>
          </div>
          <div className="start-more">
            <div className="start-tile start-placeholder">
              <PanoIcon size={20} />
              <span className="start-tile-title">Starter library</span>
              <span className="start-tile-sub">360 rooms and songs</span>
            </div>
            <div className="start-tile start-placeholder">
              <DishIcon size={20} />
              <span className="start-tile-title">Restaurant or café</span>
              <span className="start-tile-sub">From your menu</span>
            </div>
          </div>
        </div>
        <span className="skeleton skeleton-line skeleton-heading" aria-hidden="true" />
        <ul className="reel-grid" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <li key={index}>
              <span className="reel-thumb skeleton" />
            </li>
          ))}
        </ul>
      </main>
      <TabBar />
    </>
  );
}
