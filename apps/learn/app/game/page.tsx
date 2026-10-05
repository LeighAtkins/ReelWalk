import Link from "next/link";

export default function GameHome() {
  return (
    <div className="game">
      <section className="stack">
        <div>
          <p className="room-label">ReelWalk 面接ノート</p>
          <h1 className="game-hero" lang="ja">
            模擬面接ゲーム
          </h1>
          <p className="lede">Two phones, one interview. Each player opens their own page; the turns pass between them.</p>
        </div>
        <Link href="/game/interviewer/" className="role role-host" lang="ja">
          <strong>面接官</strong>
          <span>質問を読み上げて、採点します。（日本語の画面）</span>
        </Link>
        <Link href="/game/candidate/" className="role role-cand">
          <strong>Candidate · 応募者</strong>
          <span>Answer out loud in Japanese. You can&apos;t see the interviewer&apos;s screen.</span>
        </Link>
        <Link href="/" className="link-btn">
          Back to the study site
        </Link>
      </section>
    </div>
  );
}
