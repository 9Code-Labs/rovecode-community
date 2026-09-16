/** Interactive startup only. The loading screen owns stdout through module loading, resume resolution,
 *  runtime construction and the sandbox probe. runTui hands it over immediately before its first complete
 *  frame. Plain chat never loads the renderers; optional network/cache work is not a readiness barrier. */
import { join } from "node:path";
import { startIntro } from "../core/intro.ts";
import type { CliInvocation } from "./dispatch.ts";
import pkg from "../../package.json";

export async function startChat(cli: CliInvocation, argv: string[] = process.argv): Promise<void> {
  if (cli.plain) {
    const [{ runRepl }, { parseAddDirs }, { resolveBoot }] = await Promise.all([
      import("./repl.ts"), import("./run-flags.ts"), import("./resume.ts"),
    ]);
    resolveBoot(argv, join(process.cwd(), ".rovecode", "sessions")); // keep the existing invalid-resume diagnostic
    await runRepl({ yolo: cli.yolo, addDirs: parseAddDirs(argv) });
    return;
  }
  const intro = startIntro({
    write: (text) => { process.stdout.write(text); },
    tty: process.stdout.isTTY === true && !argv.includes("--no-intro") && process.env.ROVECODE_INTRO !== "0",
    version: pkg.version, holdUntilReady: true,
    size: () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onResize: (paint) => { process.stdout.on("resize", paint); return () => { process.stdout.off("resize", paint); }; },
  });
  const ac = new AbortController();
  let signalExit = 130;
  const interrupt = () => { signalExit = 130; ac.abort(new Error("startup interrupted")); };
  const terminate = () => { signalExit = 143; ac.abort(new Error("startup terminated")); };
  const finish = () => {
    intro.finish();
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  };
  // Also covers parsers that exit(2) instead of throwing. No raw input or keystroke consumption here.
  process.once("exit", finish);
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  const t0 = Number(process.env._ROVECODE_BOOT_T0 ?? -1);
  const trace = (label: string) => { if (t0 >= 0) process.stderr.write(`[boot] +${Date.now() - t0}ms ${label}\n`); };
  try {
    trace("intro started");
    intro.status("loading modules");
    const [{ runTui }, { interactiveRenderer }, { parseAddDirs }, { resolveBoot }] = await Promise.all([
      import("../tui/app.ts"), import("../tui/notify.ts"), import("./run-flags.ts"), import("./resume.ts"),
    ]);
    ac.signal.throwIfAborted();
    trace("surface modules loaded");
    intro.status("opening session");
    const cwd = process.cwd();
    const boot = resolveBoot(argv, join(cwd, ".rovecode", "sessions"));
    const addDirs = parseAddDirs(argv);
    await runTui({
      yolo: cli.yolo, acceptEdits: cli.acceptEdits,
      ...(cli.effort !== undefined ? { effort: cli.effort } : {}),
      sessionId: boot.id, ...(boot.note !== undefined ? { bootNote: boot.note } : {}),
      renderer: interactiveRenderer(cli, process.env, process.stdout, process.stdin, cwd),
      ...(cli.pet !== undefined ? { pet: cli.pet } : {}), ...(addDirs.length > 0 ? { addDirs } : {}),
      startup: { status: intro.status, finish, animationDone: intro.animationDone, signal: ac.signal },
    });
  } catch (error) {
    if (ac.signal.aborted) { process.exitCode = signalExit; return; }
    throw error;
  } finally {
    finish();
    process.off("exit", finish);
  }
}
