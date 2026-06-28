import React from "react";
import { Composition } from "remotion";
import { TimelineComposition } from "./TimelineComposition";
import type { EditorProject } from "./types";
import { STUB_REEL } from "./constants";
import { StubReel, StubReelProps } from "./StubReel";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id={STUB_REEL.id}
        component={StubReel}
        durationInFrames={STUB_REEL.durationInFrames}
        fps={STUB_REEL.fps}
        width={STUB_REEL.width}
        height={STUB_REEL.height}
        defaultProps={{
          inputVideo: "",
          caption: STUB_REEL.caption,
          brand: STUB_REEL.brand,
        }}
      />
      <Composition
        id="TimelineProject"
        component={TimelineComposition}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          project: {
            id: "default",
            name: "Default",
            width: 1080,
            height: 1920,
            fps: 30,
            tracks: [],
          } as EditorProject,
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            ...props.project.tracks.flatMap((t) =>
              t.clips.map((c) => c.startFrame + c.durationFrames)
            ),
            1
          ),
          width: props.project.width,
          height: props.project.height,
          fps: props.project.fps,
        })}
      />
    </>
  );
};
