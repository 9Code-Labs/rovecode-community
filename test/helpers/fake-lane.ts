/** Test double for the #47 lane process seam (src/lanes/process.ts LaneProcess): a scripted process
 *  that emits stdout lines (optionally spaced), then exits — or parks (`hold`) until it is interrupted
 *  or killed, recording the kill choreography in `steps`. Never touches a real CLI. `onSpawn` lets a
 *  fake "do the lane's work" (write a file into the worktree cwd) for the merge-back tests. */

import type { LaneCommand } from "../../src/lanes/types.ts";
import type { LaneProcess, LaneSpawn } from "../../src/lanes/process.ts";

export interface FakeScript {
  /** stdout lines, in order */
  lines?: string[];
  /** exit code after the lines (default 0); a kill exits 143 */
  exitCode?: number;
  /** after the lines, park until interrupt() (when it exits on it) or kill() */
  hold?: boolean;
  /** interrupt() is deliverable (default true; false = the win32 shape) */
  interruptDeliverable?: boolean;
  /** the CLI finishes its turn on SIGINT: interrupt() ends the stream with `interruptExitCode` */
  interruptExits?: boolean;
  interruptExitCode?: number;
  /** ms between lines (default 0 — a microtask hop per line) */
  delayMs?: number;
  /** stderr text reported by stderrTail() */
  stderr?: string;
  /** spawn side effect (e.g. write a file into cmd.cwd) */
  onSpawn?: (cmd: LaneCommand) => void;
  /** spawn throws (the missing-binary shape) */
  throwOnSpawn?: string;
  /** kill() is recorded but the process neither exits nor closes its pipe (an orphan holding stdout) —
   *  only abandon() ends lines(); `exited` never resolves */
  ignoreKill?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeLaneProcess implements LaneProcess {
  readonly pid: number;
  readonly steps: string[] = [];
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;
  private released = false;
  private release!: () => void;
  private readonly releasedP: Promise<void>;
  private exitCode: number;
  private gone = false;
  constructor(readonly cmd: LaneCommand, readonly script: FakeScript, pid: number) {
    this.pid = pid;
    this.exitCode = script.exitCode ?? 0;
    this.exited = new Promise<number>((r) => { this.resolveExit = r; });
    this.releasedP = new Promise<void>((r) => { this.release = () => { if (!this.released) { this.released = true; r(); } }; });
  }
  get alive(): boolean { return !this.gone; }
  async *lines(): AsyncIterable<string> {
    for (const line of this.script.lines ?? []) {
      if (this.released) break;
      if (this.script.delayMs) await sleep(this.script.delayMs); else await Promise.resolve();
      if (this.released) break;
      yield line;
    }
    if (this.script.hold && !this.released) await this.releasedP;
    if (this.zombie) return; // abandoned pipe of a process that is still alive: no exit
    this.finish(this.exitCode);
  }
  private zombie = false;
  private finish(code: number): void {
    if (this.gone) return;
    this.gone = true;
    this.resolveExit(code);
  }
  interrupt(): boolean {
    this.steps.push("interrupt");
    if (this.script.interruptDeliverable === false || this.gone) return false;
    if (this.script.interruptExits) { this.exitCode = this.script.interruptExitCode ?? 130; this.release(); }
    return true;
  }
  kill(): void {
    this.steps.push("kill");
    if (this.gone) return;
    if (this.script.ignoreKill) { this.zombie = true; return; }
    this.exitCode = 143;
    this.release();
    // the tree is dead: exit even if nobody drains the (fake) pipe any further
    this.finish(143);
  }
  abandon(): void { this.steps.push("abandon"); this.release(); }
  stderrTail(): string { return this.script.stderr ?? ""; }
}

/** A LaneSpawn over one script (or a per-command script factory), recording every spawned process. */
export function fakeLaneSpawn(script: FakeScript | ((cmd: LaneCommand) => FakeScript)) {
  const procs: FakeLaneProcess[] = [];
  const cmds: LaneCommand[] = [];
  let pid = 40_000;
  const spawn: LaneSpawn = (cmd) => {
    const s = typeof script === "function" ? script(cmd) : script;
    cmds.push(cmd);
    if (s.throwOnSpawn) throw new Error(s.throwOnSpawn);
    s.onSpawn?.(cmd);
    const p = new FakeLaneProcess(cmd, s, ++pid);
    procs.push(p);
    return p;
  };
  return { spawn, procs, cmds };
}

/** the fixture's JSONL lines (header comment included — the parser must count it as garbage) */
export function fixtureLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}
