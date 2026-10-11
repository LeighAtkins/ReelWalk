import { TabBar } from "@/components/tab-bar";

/** The account page while it loads. */
export default function Loading() {
  return (
    <>
      <main className="shell" aria-busy="true">
        <div aria-hidden="true">
          <span className="skeleton skeleton-line" style={{ width: "58%", height: 28, marginBottom: 10 }} />
          <span className="skeleton skeleton-line" style={{ width: "36%", height: 11, marginBottom: 22 }} />
          <ul className="stat-row">
            {[0, 1, 2, 3].map((index) => (
              <li key={index}>
                <span className="skeleton skeleton-line" style={{ width: 28, height: 18, margin: "0 auto 4px" }} />
                <span className="skeleton skeleton-line" style={{ width: "70%", height: 9, margin: "0 auto" }} />
              </li>
            ))}
          </ul>
          <div className="card skeleton" style={{ height: 180 }} />
        </div>
      </main>
      <TabBar />
    </>
  );
}
