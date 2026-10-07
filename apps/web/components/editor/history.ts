import type { Timeline } from "@reelwalk/core";

/**
 * Undo/redo over timeline snapshots. Timelines are small immutable values, so
 * keeping whole copies is simpler and safer than recording inverse operations.
 */
export type History = {
  past: Timeline[];
  present: Timeline;
  future: Timeline[];
  /**
   * Edits with the same key in quick succession (a slider drag) collapse into
   * one undo step. Keys starting "drag:" name one pointer gesture and collapse
   * however long the finger rests.
   */
  lastKey: string | null;
  lastAt: number;
};

const LIMIT = 100;
const COALESCE_MS = 800;

export type HistoryAction =
  | { type: "apply"; update: (timeline: Timeline) => Timeline; key?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; timeline: Timeline };

export function initHistory(timeline: Timeline): History {
  return { past: [], present: timeline, future: [], lastKey: null, lastAt: 0 };
}

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "apply": {
      let next: Timeline;
      try {
        next = action.update(state.present);
      } catch (error) {
        // A rejected edit (bad value, impossible trim) leaves the reel as it
        // was. Throwing here would unmount the whole editor.
        console.warn("edit rejected", error);
        return state;
      }
      if (next === state.present) return state;
      const now = Date.now();
      const coalesce =
        action.key !== undefined && action.key === state.lastKey && (action.key.startsWith("drag:") || now - state.lastAt < COALESCE_MS);
      return {
        past: coalesce ? state.past : [...state.past, state.present].slice(-LIMIT),
        present: next,
        future: [],
        lastKey: action.key ?? null,
        lastAt: now,
      };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
        lastKey: null,
        lastAt: 0,
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
        lastKey: null,
        lastAt: 0,
      };
    }
    case "reset":
      return initHistory(action.timeline);
  }
}
