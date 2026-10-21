import type { ComponentType } from "react";
import type { Clip, Command, CommandResult, TextOverlay, Timeline } from "@reelwalk/core";
import type { ControlSpec } from "./controls";

/**
 * Mounting points for features other workstreams add (ADR 0064). A feature
 * that changes one thing appears when the studio taps that thing: it adds a
 * control here with the target it belongs to and a panel, and the editor
 * puts the control in that selection's toolbar and shows the panel in a
 * bottom sheet. No new global button, no editor.tsx edit.
 *
 * Where the parallel workstreams landed (2026-10-22), and so where to look before adding a control:
 *  - W13 Popular now (ADR 0058):  a row in the Music sheet (target "music": Adjust / Replace open it).
 *  - W14 pacing (ADR 0059):       Energy and On the beat in the Music sheet; the finishes pace through the same engine.
 *  - W15 script mode (ADR 0060):  the Presenter sheet, from the timeline header and a presenter take's Redo take / New take.
 *  - W16 motion (ADR 0061):       shine, kinetic type and callouts inside the title's Edit sheet (target "text"), no
 *                                 extra button; a callout title hides Particles and Walk-through.
 *  - W17 critic (ADR 0062):       inside the Export sheet.
 *  - W18 variants (ADR 0063):     on the export page.
 *  - Inspect (ADR 0057):          the magnifier in the transport bar (and the I key).
 * A new feature that changes one thing mounts here instead.
 *
 * Changes go through `runCommand` (one undo step, ADR 0048) or `apply` with
 * a gesture key; a panel never replaces the timeline wholesale.
 */
export type ControlPanelProps = {
  timeline: Timeline;
  clip: Clip | null;
  text: TextOverlay | null;
  runCommand(command: Command, gesture?: string): CommandResult;
  apply(update: (timeline: Timeline) => Timeline, gesture?: string): void;
  /** The playhead, in reel milliseconds. */
  now(): number;
  seek(ms: number): void;
  toast(message: string): void;
  onClose(): void;
};

export type ExtensionControl = ControlSpec & {
  /** The sheet's title; the label when absent. */
  title?: string;
  Panel: ComponentType<ControlPanelProps>;
};

export const EXTENSION_CONTROLS: readonly ExtensionControl[] = [];
