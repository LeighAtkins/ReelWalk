import { analyseAudio } from "@reelwalk/core";

/** The track analysis already computes the same beat grid and song map. */
export function analyseAudioSamples(samples: Float32Array) {
  const track = analyseAudio(samples);
  const beat = track.bpm !== null && track.beatOffsetMs !== null ? { bpm: track.bpm, offsetMs: track.beatOffsetMs } : null;
  return { beat, songMap: beat ? { downbeats: track.downbeats, sections: track.sections } : null, track };
}
