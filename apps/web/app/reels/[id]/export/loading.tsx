/** The export screen while the render's state loads. */
export default function Loading() {
  return (
    <main className="shell" aria-busy="true">
      <header className="shell-head" aria-hidden="true">
        <span className="skeleton skeleton-pill" />
        <span className="skeleton skeleton-line" style={{ width: 120 }} />
      </header>
      <section className="export">
        <div className="export-frame stage-loading" role="status">
          <span className="focus-marks" />
          <span className="visually-hidden">Opening the export</span>
        </div>
      </section>
    </main>
  );
}
