import { applyCommand, type BrandKit, type Command, type CommandResult, type Timeline } from "@reelwalk/core";
import { COALESCE_MS, historyReducer, initHistory, type History, type HistoryAction } from "./history";

/** What the editor shows when an async proposal arrives for a reel that changed meanwhile. */
export const STALE_PROPOSAL = "The reel changed while that was being worked out, so nothing was replaced. Review the reel and ask again.";

export type DocumentState = { history: History; generation: number };
export type CommandOutcome = CommandResult & { generation: number };

/**
 * A keyed gesture in progress (a trim handle dragged, a Trim sheet slider
 * moved): its key, the reel before it began, and the reel its last step
 * left. Commands of the gesture anchor titles to `base`.
 */
type Gesture = { key: string; base: Timeline; last: Timeline };

/**
 * The editor's document (ADR 0048), framework-free so it can be tested
 * without React: the undo history (history.ts, unchanged) plus a generation
 * that rises on every change to the reel (edit, undo, redo, reset).
 *
 * Commands run synchronously against the latest state, so a caller learns at
 * once whether its command landed and the generation it produced. An async
 * proposal carries the generation it read and is refused (`stale`) when the
 * reel has moved on since.
 *
 * A gesture lives exactly as long as its undo step: a keyed command
 * continues the gesture only when the history will merge it into the same
 * entry (same key, nothing in between, a `drag:` key or within the history's
 * merge window). Undo, redo and reset end it, and so does `endGesture`
 * (a sheet closing).
 */
export function createDocumentStore(initial: Timeline, sourceDurationsMs: () => Record<string, number | null | undefined> = () => ({}), brandKit: () => BrandKit | null = () => null) {
  let state: DocumentState = { history: initHistory(initial), generation: 0 };
  let gesture: Gesture | null = null;
  const listeners = new Set<() => void>();

  const set = (next: DocumentState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  function dispatch(action: HistoryAction) {
    // Only an edit can continue a gesture: undo, redo and reset end it.
    if (action.type !== "apply") gesture = null;
    const history = historyReducer(state.history, action);
    if (history === state.history) return;
    set({ history, generation: history.present === state.history.present ? state.generation : state.generation + 1 });
  }

  /** One user action, one command, at most one undo entry (a keyed gesture's steps merge into one, as the history does). */
  function runCommand(command: Command, key?: string): CommandOutcome {
    const { history } = state;
    const present = history.present;
    const merges = key !== undefined && history.lastKey === key && (key.startsWith("drag:") || Date.now() - history.lastAt < COALESCE_MS);
    const continues = merges && gesture !== null && gesture.key === key && gesture.last === present;
    const base = continues ? gesture!.base : present;
    let result = null as CommandResult | null;
    dispatch({
      type: "apply",
      key,
      update: (timeline) => {
        result = applyCommand(timeline, command, { generation: state.generation, sourceDurationsMs: sourceDurationsMs(), gestureBase: base, brandKit: brandKit() });
        return result.timeline;
      },
    });
    const landed: CommandResult = result ?? { timeline: state.history.present, changes: [], rejected: "The change could not be applied." };
    if (key === undefined) gesture = null;
    else if (!landed.rejected && !landed.stale) gesture = { key, base, last: state.history.present };
    return { ...landed, generation: state.generation };
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    runCommand,
    /** The reel and its generation right now, for an async request to carry. */
    snapshot: () => ({ timeline: state.history.present, generation: state.generation }),
    /** Ends the gesture in progress (a sheet closed): the next keyed command starts a new one. */
    endGesture() {
      gesture = null;
    },
  };
}

export type DocumentStore = ReturnType<typeof createDocumentStore>;
