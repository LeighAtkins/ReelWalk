import React from "react";
import { Composition } from "remotion";
import { TimelineComposition } from "./TimelineComposition";
import type { EditorProject } from "./editor-types";
import { emptyTimeline } from "@reelwalk/core";
import { ReelComposition, reelDurationInFrames } from "./reel/ReelComposition";
import { REEL_COMPOSITION_ID, type ReelProps } from "./reel/types";
import { STUB_REEL } from "./constants";
import { StubReel } from "./StubReel";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id={REEL_COMPOSITION_ID}
        component={ReelComposition}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ timeline: emptyTimeline(), assets: {} } satisfies ReelProps}
        calculateMetadata={({ props }) => ({ durationInFrames: reelDurationInFrames(props.timeline, 30) })}
      />
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
