import "./game.css";

export const metadata = { title: "模擬面接ゲーム" };

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return <main className="game-page">{children}</main>;
}
