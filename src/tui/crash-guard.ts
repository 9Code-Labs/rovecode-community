/** What happens to your terminal when rovecode dies badly, and what you get to read afterwards.
 *
 *  THE BUG THIS EXISTS FOR (reported 2026-09-07, with a screenshot). The TUI puts the terminal into a
 *  mode the shell cannot live in: alt screen (`?1049h`), raw stdin, mouse reporting (`?1000/1002/1006h`)
 *  and focus reporting (`?1004h`). Quitting cleanly undoes every one of those. Dying does not. The quit
 *  path was careful and the crash path did not exist, so an uncaught exception left the terminal in that
 *  mode with nobody to speak for it: the shell prompt came back INSIDE the alt screen, still covered by
 *  the last painted frame, and every mouse movement afterwards typed escape sequences at the prompt —
 *  `[<222;39;51M[<222;38;51M…` walking down the screen as the pointer moved. To the person at the
 *  keyboard that is not "rovecode crashed", it is "my terminal is broken", and the actual error had
 *  already scrolled away underneath a frame that was never erased.
 *
 *  So this does two things, in this order, and the order is the point:
 *    1. RESTORE THE TERMINAL, before anything that could itself throw. Whatever else goes wrong, the
 *       person gets their shell back.
 *    2. WRITE THE REASON DOWN, to a file, because the one place a crash message cannot survive is the
 *       screen it was printed on — the alt screen is discarded on restore, taking the stack with it.
 *       Then one line on stderr saying where that file is.
 *
 *  WHY A FILE AND NOT JUST STDERR. Restoring the alt screen erases everything printed while the TUI was
 *  up. A stack trace written a microsecond before `?1049l` is gone by the time the shell redraws. The
 *  log is the only copy that survives the fix.
 *
 *  Handlers, and why exactly these. `uncaughtException` and `unhandledRejection` are the two ways a
 *  surface actually dies — the second is the more common one here, because almost everything in the boot
 *  path is async. `exit` is the belt-and-braces restore for any path that reaches `process.exit()`
 *  without going through the quit code, and it logs nothing, because a normal quit is not a crash.
 *  SIGINT is deliberately NOT handled: in raw mode the terminal delivers Ctrl+C as a keystroke to the
 *  app rather than as a signal, so a handler here would be dead code on the path it looks like it covers
 *  and would silently change Ctrl+C's meaning if raw mode ever failed to engage. */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** the process surface this guard binds to — an object in tests, `process` in production */
export interface CrashProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
}

export interface CrashGuardDeps {
  /** put the terminal back the way it was found. MUST be idempotent and MUST NOT throw — it runs first,
   *  on every path, including inside the `exit` handler where nothing async can be awaited. */
  restore: () => void;
  /** where crash logs go; `<rovecodeHome>/logs` in production */
  logDir: string;
  /** version stamped into the log, so a report names the build it came from */
  version?: string;
  process?: CrashProcess;
  /** seams (tests) */
  now?: () => Date;
  writeFile?: (path: string, text: string) => void;
  stderr?: (line: string) => void;
}

/** what a crash log is called: one file per crash, sortable, no collisions within a second */
export function crashLogName(at: Date, seq = 0): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return seq === 0 ? `crash-${stamp}.log` : `crash-${stamp}-${seq}.log`;
}

/** An error rendered for someone reading the file a day later: name, message, stack, and the plain
 *  value when what was thrown is not an Error at all (a rejected string, a thrown object — common
 *  enough in async code that omitting it would blank out the interesting cases). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause !== undefined ? `\ncaused by: ${describeError(err.cause)}` : "";
    return `${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}${cause}`;
  }
  if (typeof err === "object" && err !== null) {
    try { return `non-Error value thrown: ${JSON.stringify(err)}`; } catch { return `non-Error value thrown: ${String(err)}`; }
  }
  return `non-Error value thrown: ${String(err)}`;
}

/** Is this error a TRANSIENT NETWORK failure that cannot be fixed from inside the process — Bun's
 *  fetch emits DNS/resolve failures BOTH as the promise rejection every caller catches AND as a
 *  stream `error` event on an internal socket (node:streams/destroy → emitErrorNT), and when the
 *  network died mid-boot (adapter switch, VPN drop, DNS unresponsive) that second emission reaches
 *  `uncaughtException` with an empty ResolveMessage. Killing the TUI for it loses the session and
 *  the terminal for something that heals on its own; the honest move is to log it and keep going.
 *  Deliberately NARROW: only the resolve/connect family, only as an uncaught stream error — a
 *  rejected promise with the same text still travels its normal path. */
export function recoverableNetworkError(err: unknown): boolean {
  // "Unhandled error. (ResolveMessage {})" — the stream wrapper stringifies its payload into the message
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/\(ResolveMessage \{\}\)|getAddrInfo|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) return true;
  // the payload's own facts: a `code` property rides on Errors (Node convention) and bare objects alike
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    if (String(name).includes("Resolve") || /^(EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(String(code))) return true;
  }
  return false;
}

/** the body of a crash log. Kept plain text and self-describing: it is meant to be pasted into a
 *  message, so it must make sense with no surrounding context. */
export function crashReport(kind: string, err: unknown, at: Date, version?: string): string {
  return [
    `rovecode crash — ${kind}`,
    `when:     ${at.toISOString()}`,
    `version:  ${version ?? "unknown"}`,
    `platform: ${process.platform} ${process.arch}`,
    `cwd:      ${process.cwd()}`,
    "",
    describeError(err),
    "",
  ].join("\n");
}

/** Install the guard. Returns an uninstall function — the clean quit path calls it, so a normal exit
 *  does not run a restore twice and a test does not leave listeners on the real process. */
export function installCrashGuard(deps: CrashGuardDeps): () => void {
  const proc = deps.process ?? (process as unknown as CrashProcess);
  const now = deps.now ?? (() => new Date());
  const stderr = deps.stderr ?? ((line: string) => { try { process.stderr.write(line + "\n"); } catch { /* the pipe may be gone too */ } });
  const writeFile = deps.writeFile ?? ((path: string, text: string) => { appendFileSync(path, text, "utf8"); });

  let restored = false;
  const restoreOnce = (): void => {
    if (restored) return;
    restored = true;
    try { deps.restore(); } catch { /* a restore that throws must not stop the log or the exit */ }
  };

  /** returns the path written, or null when the log could not be written — which must not be fatal:
   *  a crash we cannot record is still a crash we have to get the terminal back from */
  const log = (kind: string, err: unknown): string | null => {
    const at = now();
    try {
      mkdirSync(deps.logDir, { recursive: true });
      const path = join(deps.logDir, crashLogName(at));
      writeFile(path, crashReport(kind, err, at, deps.version));
      return path;
    } catch {
      return null;
    }
  };

  const fatal = (kind: string) => (err: unknown): void => {
    // a transient network failure arriving as a stream error (Bun's fetch emits DNS/resolve failures
    // both ways) is NOT a crash: log it to the same file the crashes go to, keep the session alive.
    // Everything else keeps the old contract — restore first, then the reason, then exit 1.
    if (recoverableNetworkError(err)) {
      const path = log(`transient network error (recovered, ${kind})`, err);
      if (path !== null) stderr(`rovecode: a network call failed and was left behind (${describeError(err).split("\n")[0]}) — details: ${path}`);
      return;
    }
    restoreOnce();                       // FIRST: the terminal is usable even if everything below fails
    const path = log(kind, err);
    // Both lines go to stderr because the screen they would have been printed on has just been erased.
    stderr(`rovecode crashed (${kind}). ${path !== null ? `Details: ${path}` : "The crash log could not be written."}`);
    stderr(describeError(err));
    proc.exit(1);
  };

  const onUncaught = fatal("uncaught exception");
  const onRejection = fatal("unhandled rejection");
  const onExit = (): void => { restoreOnce(); };   // no log: a normal exit is not a crash

  proc.on("uncaughtException", onUncaught as (...a: unknown[]) => void);
  proc.on("unhandledRejection", onRejection as (...a: unknown[]) => void);
  proc.on("exit", onExit);

  return () => {
    proc.off("uncaughtException", onUncaught as (...a: unknown[]) => void);
    proc.off("unhandledRejection", onRejection as (...a: unknown[]) => void);
    proc.off("exit", onExit);
  };
}
