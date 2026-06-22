import React from "react";
import { Composition } from "remotion";
import { STUB_REEL } from "./constants";
import { StubReel, StubReelProps } from "./StubReel";

export const RemotionRoot: React.FC = () => {
  return (
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
  );
};
