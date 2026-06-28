import { create } from "zustand";
import type { Clip, ClipType, EditorProject, Track } from "./types";
import { VERTICAL_1080, DEFAULT_DURATION } from "./types";

const uid = () => Math.random().toString(36).slice(2, 11);

const SNAP_THRESHOLD = 4; // frames

function createEmptyProject(): EditorProject {
  return {
    id: uid(),
    name: "Untitled Project",
    ...VERTICAL_1080,
    tracks: [
      { id: uid(), type: "video", name: "Track 1", clips: [], visible: true },
    ],
  };
}

/** Find the end frame of the last clip on a track */
function trackEndFrame(track: Track): number {
  if (track.clips.length === 0) return 0;
  return Math.max(
    ...track.clips.map((c) => c.startFrame + c.durationFrames)
  );
}

/** Check if a clip at startFrame with duration overlaps any other clip on the track */
function findOverlap(
  track: Track,
  startFrame: number,
  durationFrames: number,
  excludeClipId?: string
): { start: number; end: number } | null {
  const end = startFrame + durationFrames;
  for (const clip of track.clips) {
    if (clip.id === excludeClipId) continue;
    const clipEnd = clip.startFrame + clip.durationFrames;
    if (startFrame < clipEnd && end > clip.startFrame) {
      return { start: clip.startFrame, end: clipEnd };
    }
  }
  return null;
}

/** Snap a frame position to nearby clip edges or playhead */
function snap(
  frame: number,
  tracks: Track[],
  playhead: number,
  excludeClipId?: string
): number {
  const candidates: number[] = [0, playhead];

  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      candidates.push(clip.startFrame);
      candidates.push(clip.startFrame + clip.durationFrames);
    }
  }

  for (const c of candidates) {
    if (Math.abs(frame - c) <= SNAP_THRESHOLD) return c;
  }
  return frame;
}

function calcTotalDuration(tracks: Track[]): number {
  let max = 150;
  for (const track of tracks) {
    const end = trackEndFrame(track);
    if (end > max) max = end;
  }
  return max;
}

interface EditorState {
  project: EditorProject;
  currentFrame: number;
  selectedClipId: string | null;
  isPlaying: boolean;
  totalDuration: number;

  setCurrentFrame: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  selectClip: (clipId: string | null) => void;

  // Add clip — appends to end of track or at playhead
  addClipToTrack: (
    trackId: string,
    type: ClipType,
    assetUrl: string,
    name: string,
    opts?: { durationFrames?: number; startFrame?: number }
  ) => string;
  
  // Drag clip to new position — handles snapping + collision
  dragClip: (clipId: string, newStartFrame: number) => void;
  
  // Trim clip edge
  trimClip: (clipId: string, newDuration: number, fromStart?: boolean) => void;
  
  // Split clip at playhead
  splitClipAtPlayhead: (clipId: string) => void;

  removeClip: (clipId: string) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;

  toggleTrackVisibility: (trackId: string) => void;
  addTrack: (type: ClipType) => void;
  removeTrack: (trackId: string) => void;

  setProjectSize: (preset: "vertical" | "horizontal" | "square") => void;
  loadProject: (project: EditorProject) => void;
  exportProject: () => EditorProject;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  project: createEmptyProject(),
  currentFrame: 0,
  selectedClipId: null,
  isPlaying: false,
  totalDuration: 150,

  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  selectClip: (clipId) => set({ selectedClipId: clipId }),

  addClipToTrack: (trackId, type, assetUrl, name, opts) => {
    const clipId = uid();
    const state = get();
    const track = state.project.tracks.find((t) => t.id === trackId);
    if (!track) return clipId;

    const duration = opts?.durationFrames ?? DEFAULT_DURATION[type];

    // Determine start position: explicit > playhead > end of track
    let startFrame: number;
    if (opts?.startFrame !== undefined) {
      startFrame = opts.startFrame;
    } else if (track.clips.length === 0) {
      startFrame = 0;
    } else {
      // Append after last clip, or at playhead if playhead is past last clip end
      const endOfTrack = trackEndFrame(track);
      startFrame = state.currentFrame >= endOfTrack ? state.currentFrame : endOfTrack;
    }

    // Snap to playhead and clip edges
    startFrame = snap(startFrame, state.project.tracks, state.currentFrame);

    const newClip: Clip = {
      id: clipId,
      type,
      assetUrl,
      name,
      startFrame: Math.max(0, startFrame),
      durationFrames: duration,
    };

    // Add pano defaults — spherical camera
    if (type === "pano") {
      newClip.panStartAngle = 180;  // face center of pano
      newClip.panEndAngle = 270;    // pan right by 90°
      newClip.startPitch = 0;       // look straight ahead
      newClip.endPitch = 0;
      newClip.fov = 65;
      newClip.endFov = 65;
    }

    set((s) => {
      const tracks = s.project.tracks.map((t) =>
        t.id === trackId ? { ...t, clips: [...t.clips, newClip] } : t
      );
      // Sort clips by startFrame
      tracks.forEach((t) => t.clips.sort((a, b) => a.startFrame - b.startFrame));
      return {
        project: { ...s.project, tracks },
        totalDuration: calcTotalDuration(tracks),
        selectedClipId: clipId,
      };
    });

    return clipId;
  },

  dragClip: (clipId, newStartFrame) =>
    set((state) => {
      const tracks = state.project.tracks.map((t) => {
        // Find which track has this clip
        const hasClip = t.clips.some((c) => c.id === clipId);
        if (!hasClip) return t;

        const snapped = snap(
          Math.max(0, newStartFrame),
          state.project.tracks,
          state.currentFrame,
          clipId
        );

        return {
          ...t,
          clips: t.clips
            .map((c) =>
              c.id === clipId ? { ...c, startFrame: snapped } : c
            )
            .sort((a, b) => a.startFrame - b.startFrame),
        };
      });
      return { project: { ...state.project, tracks } };
    }),

  trimClip: (clipId, newDuration, fromStart = false) =>
    set((state) => {
      const dur = Math.max(1, newDuration);
      const tracks = state.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (fromStart) {
            const diff = c.durationFrames - dur;
            return {
              ...c,
              startFrame: c.startFrame + diff,
              durationFrames: dur,
              trimStart: (c.trimStart ?? 0) + diff,
            };
          }
          return { ...c, durationFrames: dur };
        }),
      }));
      return {
        project: { ...state.project, tracks },
        totalDuration: calcTotalDuration(tracks),
      };
    }),

  splitClipAtPlayhead: (clipId) =>
    set((state) => {
      const frame = state.currentFrame;
      const tracks = state.project.tracks.map((t) => {
        const clip = t.clips.find((c) => c.id === clipId);
        if (!clip) return t;
        if (frame <= clip.startFrame || frame >= clip.startFrame + clip.durationFrames)
          return t;

        const firstHalf: Clip = {
          ...clip,
          durationFrames: frame - clip.startFrame,
        };
        const secondHalf: Clip = {
          ...clip,
          id: uid(),
          startFrame: frame,
          durationFrames: clip.durationFrames - (frame - clip.startFrame),
          trimStart: (clip.trimStart ?? 0) + (frame - clip.startFrame),
        };

        return {
          ...t,
          clips: t.clips
            .filter((c) => c.id !== clipId)
            .concat(firstHalf, secondHalf)
            .sort((a, b) => a.startFrame - b.startFrame),
        };
      });
      return { project: { ...state.project, tracks } };
    }),

  removeClip: (clipId) =>
    set((state) => {
      const tracks = state.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.id !== clipId),
      }));
      return {
        project: { ...state.project, tracks },
        totalDuration: calcTotalDuration(tracks),
        selectedClipId:
          state.selectedClipId === clipId ? null : state.selectedClipId,
      };
    }),

  updateClip: (clipId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tracks: state.project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, ...patch } : c
          ),
        })),
      },
    })),

  toggleTrackVisibility: (trackId) =>
    set((state) => ({
      project: {
        ...state.project,
        tracks: state.project.tracks.map((t) =>
          t.id === trackId ? { ...t, visible: !t.visible } : t
        ),
      },
    })),

  addTrack: (type) =>
    set((state) => {
      const count = state.project.tracks.filter((t) => t.type === type).length + 1;
      return {
        project: {
          ...state.project,
          tracks: [
            ...state.project.tracks,
            {
              id: uid(),
              type,
              name: `${type === "pano" ? "360" : type.charAt(0).toUpperCase() + type.slice(1)} ${count}`,
              clips: [],
              visible: true,
            },
          ],
        },
      };
    }),

  removeTrack: (trackId) =>
    set((state) => ({
      project: {
        ...state.project,
        tracks: state.project.tracks.filter((t) => t.id !== trackId),
      },
    })),

  setProjectSize: (preset) =>
    set((state) => {
      if (preset === "vertical")
        return { project: { ...state.project, ...VERTICAL_1080 } };
      if (preset === "horizontal")
        return { project: { ...state.project, width: 1920, height: 1080, fps: 30 } };
      return { project: { ...state.project, width: 1080, height: 1080, fps: 30 } };
    }),

  loadProject: (project) =>
    set({
      project,
      currentFrame: 0,
      selectedClipId: null,
      isPlaying: false,
      totalDuration: calcTotalDuration(project.tracks),
    }),

  exportProject: () => get().project,
}));
