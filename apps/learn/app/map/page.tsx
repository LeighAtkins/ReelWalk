import { topics } from "@/lib/content";
import { SystemMap, type NodeInfo } from "@/components/SystemMap";

export const metadata = { title: "路線図: the ReelWalk system map" };

export default function MapPage() {
  const info: Record<string, NodeInfo> = Object.fromEntries(topics.map((t) => [t.id, { name: t.name, oneLiner: t.oneLiner }]));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>The system, as a route map</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Follow an upload, an export, a crash or a deploy stop by stop, with each step narrated in Japanese.
        </p>
      </div>
      <SystemMap info={info} />
    </div>
  );
}
