/** Scratch directories for tests (ledger #74, test hygiene): mkdtemp under os.tmpdir() and REMOVE it after the
 *  test that made it, whether that test passed or failed. A bare `rmSync(dir)` at the end of a test body is
 *  skipped when an expect above it throws — the dir then survives in the machine TEMP (the #74 scout found a
 *  9 300-dir backlog). `scratchDirs()` is called ONCE at a test file's top level; it registers one afterEach in
 *  that file's scope (bun caches this module across files, so the registration has to happen per caller) and
 *  returns the factory. The guard in test/hygiene-preload.ts fails a file that leaves anything under tmpdir(). */

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `scratch("rovecode-hl-")` → a fresh `mkdtempSync(join(tmpdir(), "rovecode-hl-"))`, swept after the current test */
export type Scratch = (prefix: string) => string;

/** Call once per test file (top level, outside describe): every dir the returned factory makes is removed in an
 *  afterEach of the calling file — pass or fail — with the Windows retry below. */
export function scratchDirs(): Scratch {
  const pending: string[] = [];
  afterEach(() => {
    const dirs = pending.splice(0);
    for (const d of dirs) removeDir(d);
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    pending.push(dir);
    return dir;
  };
}

/** rmSync(recursive, force) with a bounded retry (about 2 s in all) for the Windows EBUSY / ENOTEMPTY / EPERM
 *  window: a child process, a TUI app left running by a failed deadline, or antivirus still holds a handle on a
 *  file inside the tree for a moment after the test ends. */
export function removeDir(dir: string, attempts = 8): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM";
      if (!transient || attempt >= attempts) throw e;
      Bun.sleepSync(60 * attempt);
    }
  }
}
