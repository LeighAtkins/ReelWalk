// Core timeline types for the ReelWalk editor

export type ClipType = "video" | "image" | "pano" | "text" | "audio";

export interface Clip {
  id: string;
  type: ClipType;
  assetUrl: string;
  name: string;
  /** Where on the timeline this clip starts (in frames) */
  startFrame: number;
  /** Duration of this clip in frames */
  durationFrames: number;
  /** Source trim start (for video/audio — where in the source to begin) */
  trimStart?: number;
  /** Text content for text clips */
  text?: string;
  /** Font size for text clips */
  fontSize?: number;
  /** Color for text clips */
  color?: string;

  // 360 pano settings — spherical (Street View style)
  /** Start yaw (horizontal angle) in degrees, 0-360 */
  panStartAngle?: number;
  /** End yaw (horizontal angle) in degrees, 0-360 */
  panEndAngle?: number;
  /** Start pitch (vertical angle) in degrees, -90 to +90 */
  startPitch?: number;
  /** End pitch (vertical angle) in degrees, -90 to +90 */
  endPitch?: number;
  /** Field of view in degrees, 30-120 */
  fov?: number;
  /** Ending field of view in degrees (for zoom in/out during pan) */
  endFov?: number;
}

export type TrackType = ClipType;

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  clips: Clip[];
  muted?: boolean;
  locked?: boolean;
  visible: boolean;
}

export interface EditorProject {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
}

export const VERTICAL_1080 = { width: 1080, height: 1920, fps: 30 } as const;
export const HORIZONTAL_1080 = { width: 1920, height: 1080, fps: 30 } as const;
export const SQUARE_1080 = { width: 1080, height: 1080, fps: 30 } as const;

/** Default durations per clip type (at 30fps) */
export const DEFAULT_DURATION: Record<ClipType, number> = {
  video: 300, // 10s
  image: 150, // 5s
  pano: 300, // 10s
  text: 90, // 3s
  audio: 300, // 10s
};
