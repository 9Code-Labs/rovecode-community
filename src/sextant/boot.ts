/** The boot gate (#46): the cockpit stays in its reveal animation until every panel the layout asked
 *  for has painted CLEAN at least once — then `ready` flips and the surface accepts submits. A panel
 *  that keeps faulting can never lock the UI: the cap forces readiness and the toast already names the
 *  fault (frame.ts safe()). Future surfaces/versions get the same discipline by constructing one of
 *  these and asking it, instead of re-rolling boot timing by hand.
 *
 *  Wiring: the frame loop owns the gate → renderFrame's per-panel guard reports clean/fault into it →
 *  the loop holds FRAME_MS pacing and swallows submits until `ready`. */

import { REVEAL_STEP_MS } from "./frame.ts";

/** panels the gate knows about; the loop re-declares the live set every frame (layout-dependent) */
export const BOOT_PANELS = ["files", "code", "messages", "plan", "usage", "pet"] as const;

/** the animation itself: six reveal steps at 90 ms + a beat to settle */
export const BOOT_ANIM_MS = REVEAL_STEP_MS * 6;

/** a faulting panel may delay readiness at most this long — then the gate opens anyway */
export const BOOT_CAP_MS = 3000;

export interface BootGate {
  /** true once every live panel painted clean (and the animation finished) or the cap elapsed */
  readonly ready: boolean;
  /** 0..1 — animation progress for loaders; faults do not stall it (the cap guarantees 1) */
  readonly progress: number;
  /** names of live panels that have not painted clean yet */
  readonly pending: readonly string[];
}

export interface Boot {
  readonly gate: BootGate;
  /** frame loop → gate: the clock, and which panels this layout actually shows */
  tick(now: number, livePanels: readonly string[]): void;
  /** renderFrame safe() → gate: a panel painted clean / threw */
  clean(panel: string): void;
  fault(panel: string): void;
}

export function createBoot(bootAt: number): Boot {
  const cleanPanels = new Set<string>();
  const faulted = new Set<string>();
  let live: readonly string[] = [...BOOT_PANELS];
  let now = bootAt;

  const gate: BootGate = {
    get ready(): boolean {
      const animDone = now - bootAt >= BOOT_ANIM_MS;
      if (now - bootAt >= BOOT_CAP_MS) return true;
      if (!animDone) return false;
      return live.every((p) => cleanPanels.has(p) || faulted.has(p));
    },
    get progress(): number {
      return Math.min(1, (now - bootAt) / BOOT_ANIM_MS);
    },
    get pending(): readonly string[] {
      return live.filter((p) => !cleanPanels.has(p) && !faulted.has(p));
    },
  };

  return {
    gate,
    tick(n: number, livePanels: readonly string[]): void {
      now = n;
      live = livePanels;
    },
    clean(panel: string): void {
      cleanPanels.add(panel);
      faulted.delete(panel);
    },
    fault(panel: string): void {
      faulted.add(panel); // faults count toward readiness — the cap + toast carry the story
    },
  };
}
