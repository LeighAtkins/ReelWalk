import { useCallback, useReducer, useRef } from "react";
import { applyCommand, type Command, type CommandResult, type Timeline } from "@reelwalk/core";
import { historyReducer, initHistory, type History, type HistoryAction } from "./history";

/** What the editor shows when an async proposal arrives for a reel that changed meanwhile. */
export const STALE_PROPOSAL = "The reel changed while that was being worked out, so nothing was replaced. Review the reel and ask again.";

type Store = { history: History; generation: number };
/** The gesture a keyed command belongs to: its key, the reel before it began, and the reel its last step left. */
type Gesture = { key: string; base: Timeline; last: Timeline };

/**
 * The editor's document (ADR 0048): the undo history plus a generation that
 * goes up on every change to the reel (an edit, an undo, a redo). Commands
 * run synchronously against the latest state, so a caller learns at once
 * whether its command landed and the generation it produced; an async
 * proposal carries the generation it was computed against and is refused
 * (`stale`) when the reel has moved on since.
 */
export function useDocument(initial: Timeline, sourceDurationsMs: () => Record<string, number | null | undefined>) {
  const store = useRef<Store | null>(null);
  if (store.current === null) store.current = { history: initHistory(initial), generation: 0 };
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const gesture = useRef<Gesture | null>(null);

  const dispatch = useCallback((action: HistoryAction) => {
    const before = store.current!;
    const history = historyReducer(before.history, action);
    if (history === before.history) return;
    store.current = { history, generation: history.present === before.history.present ? before.generation : before.generation + 1 };
    rerender();
  }, []);

  /** One user action, one command, at most one undo entry (edits with the same `key` in quick succession still merge, as a drag does). */
  const runCommand = useCallback(
    (command: Command, key?: string): CommandResult & { generation: number } => {
      let result = null as CommandResult | null;
      const present = store.current!.history.present;
      // A keyed command right after another with the same key, nothing in between, continues that gesture.
      const continues = key !== undefined && gesture.current?.key === key && gesture.current.last === present;
      const base = continues ? gesture.current!.base : present;
      dispatch({
        type: "apply",
        key,
        update: (timeline) => {
          result = applyCommand(timeline, command, { generation: store.current!.generation, sourceDurationsMs: sourceDurationsMs(), gestureBase: base });
          return result.timeline;
        },
      });
      const now = store.current!;
      gesture.current = key === undefined ? null : { key, base, last: now.history.present };
      // A command that threw (an invalid proposal) leaves the reel as it was, with no changes.
      const landed: CommandResult = result ?? { timeline: now.history.present, changes: [] };
      return { ...landed, generation: now.generation };
    },
    [dispatch, sourceDurationsMs],
  );

  /** The reel and its generation right now, for an async request to carry. */
  const snapshot = useCallback(() => ({ timeline: store.current!.history.present, generation: store.current!.generation }), []);

  return { history: store.current.history, generation: store.current.generation, dispatch, runCommand, snapshot };
}
