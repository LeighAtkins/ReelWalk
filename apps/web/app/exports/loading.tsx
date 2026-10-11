import { TabBar } from "@/components/tab-bar";

/** The exports list while it loads. */
export default function Loading() {
  return (
    <>
      <main className="shell" aria-busy="true">
        <h1 style={{ marginBottom: 16 }}>Exports</h1>
        <ul className="export-list" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="export-row">
              <span className="mini-frame skeleton" />
              <span className="export-row-body">
                <span className="skeleton skeleton-line" style={{ width: "62%" }} />
                <span className="skeleton skeleton-line" style={{ width: "38%", height: 10 }} />
              </span>
              <span className="skeleton skeleton-pill" style={{ width: 72, height: 22 }} />
            </li>
          ))}
        </ul>
      </main>
      <TabBar />
    </>
  );
}
