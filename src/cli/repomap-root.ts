/** Background indexing is useful in a project, not at the home/filesystem root. A launch from home
 *  otherwise parses unrelated SDK/cache files under AppData until the 2000-source cap is reached.
 *  This gates only automatic interactive warmup; explicit headless builds are unchanged. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parse, relative, resolve } from "node:path";

export function shouldWarmRepoMap(cwd: string, home: string = homedir()): boolean {
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const dir = canonical(cwd);
  return relative(dir, parse(dir).root) !== "" && relative(dir, canonical(home)) !== "";
}
