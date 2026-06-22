import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type StubReelProps = {
  inputVideo: string;
  caption: string;
  brand: string;
};

function isImage(filename: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

const palette = {
  ink: "#121417",
  paper: "#f7f4ef",
  mint: "#58c4a8",
  coral: "#f26d5b",
  blue: "#2d6cdf",
};

export const StubReel: React.FC<StubReelProps> = ({ inputVideo, caption, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const marker = spring({ frame, fps, config: { damping: 18, stiffness: 80 } });
  const markerX = interpolate(marker, [0, 1], [150, 420]);
  const markerY = interpolate(marker, [0, 1], [470, 260]);
  const videoSrc = inputVideo.startsWith("http://") || inputVideo.startsWith("https://") ? inputVideo : staticFile(inputVideo);

  return (
    <AbsoluteFill style={{ backgroundColor: palette.ink, fontFamily: "Inter, Arial, sans-serif" }}>
      {inputVideo ? (
        isImage(inputVideo) ? (
          <Img
            src={videoSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "saturate(0.9) brightness(0.72)",
            }}
          />
        ) : (
          <OffthreadVideo
            src={videoSrc}
            muted
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "saturate(0.9) brightness(0.72)",
            }}
          />
        )
      ) : (
        <AbsoluteFill style={{ background: `linear-gradient(160deg, ${palette.ink}, #35403f)` }} />
      )}

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(18,20,23,0.1) 0%, rgba(18,20,23,0.18) 48%, rgba(18,20,23,0.74) 100%)",
        }}
      />

      <Sequence from={0}>
        <div
          style={{
            position: "absolute",
            top: 92,
            right: 72,
            width: 430,
            height: 600,
            borderRadius: 8,
            backgroundColor: palette.paper,
            boxShadow: "0 24px 80px rgba(0,0,0,0.34)",
            overflow: "hidden",
          }}
        >
          <div style={{ position: "absolute", inset: 34, border: "12px solid #2b2e34" }} />
          <div style={{ position: "absolute", left: 68, top: 70, width: 150, height: 180, border: "8px solid #2b2e34" }} />
          <div style={{ position: "absolute", left: 218, top: 70, width: 142, height: 180, border: "8px solid #2b2e34" }} />
          <div style={{ position: "absolute", left: 68, top: 250, width: 292, height: 120, border: "8px solid #2b2e34" }} />
          <div style={{ position: "absolute", left: 68, top: 370, width: 145, height: 145, border: "8px solid #2b2e34" }} />
          <div style={{ position: "absolute", left: 213, top: 370, width: 147, height: 145, border: "8px solid #2b2e34" }} />
          <span style={{ position: "absolute", left: 98, top: 150, color: palette.ink, fontSize: 32, fontWeight: 700 }}>
            BED
          </span>
          <span style={{ position: "absolute", left: 236, top: 150, color: palette.ink, fontSize: 32, fontWeight: 700 }}>
            BATH
          </span>
          <span style={{ position: "absolute", left: 128, top: 300, color: palette.ink, fontSize: 34, fontWeight: 800 }}>
            LIVING
          </span>
          <div
            style={{
              position: "absolute",
              left: markerX,
              top: markerY,
              width: 54,
              height: 54,
              borderRadius: 999,
              backgroundColor: palette.coral,
              border: `10px solid ${palette.paper}`,
              boxShadow: "0 10px 28px rgba(0,0,0,0.32)",
            }}
          />
        </div>

        <div
          style={{
            position: "absolute",
            left: 72,
            right: 72,
            bottom: 220,
            color: "white",
            fontSize: 76,
            lineHeight: 1.04,
            fontWeight: 900,
            textShadow: "0 6px 28px rgba(0,0,0,0.46)",
          }}
        >
          {caption}
        </div>

        <div
          style={{
            position: "absolute",
            left: 72,
            bottom: 96,
            display: "flex",
            alignItems: "center",
            gap: 20,
            color: "white",
            fontSize: 34,
            fontWeight: 800,
          }}
        >
          <div style={{ width: 58, height: 58, borderRadius: 8, backgroundColor: palette.mint }} />
          <span>{brand}</span>
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};
