/**
 * ReelWalk Remotion Composition with smooth panning
 */
import { STUB_REEL } from "./constants";

export const ReelWalkPanning: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // Frame-based panning: -20° to +20° over 240 frames (8s at 30fps)
  const panProgress = frame / STUB_REEL.durationInFrames;
  const yaw = interpolate(panProgress, [0, 0.5, 1], [-20, 0, 20], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "black", overflow: "hidden" }}>
      {/* Panning background */}
      <AbsoluteFill>
        <Img
          src={inputVideo}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `perspective(1000px) rotateY(${yaw}deg)`,
            transformOrigin: "center center",
          }}
        />
      </AbsoluteFill>

      {/* Gradient overlay for text readability */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0.65))",
        }}
      />

      {/* Text animation */}
      <Sequence from={20}>
        <AbsoluteFill
          style={{
            justifyContent: "flex-end",
            padding: 64,
            transform: `translateY(${spring({
              frame: frame - 20,
              fps,
              config: { damping: 18, stiffness: 90 },
              from: 80,
              to: 0,
            })}px)`,
            opacity: spring({
              frame: frame - 20,
              fps,
              config: { damping: 18, stiffness: 90 },
              from: 0,
              to: 1,
            }),
          }}
        >
          <div style={{ fontSize: 64, fontWeight: 700, color: "white" }}>
            {listing.address ?? "Beautiful Interior"}
          </div>
          {listing.price ? (
            <div style={{ fontSize: 42, color: "white", marginTop: 16 }}>
              {listing.price}
            </div>
          ) : null}
        </AbsoluteFill>
      </Sequence>

      {/* Brand accent */}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "flex-end",
          padding: 64,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 10,
              height: 30,
              backgroundColor: "#58C4A8",
            }}
          />
          <div style={{ fontSize: 30, color: "white", fontWeight: 600 }}>
            ReelWalk
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};