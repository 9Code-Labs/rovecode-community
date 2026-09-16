/** Cloning at a ref, and the one subtle decision in it.
 *
 *  `--ref` takes a branch, a tag or a commit, and git needs a DIFFERENT command for the last one:
 *  `clone --depth 1 --branch <x>` works for a branch or a tag and fails for a bare commit, so a commit has
 *  to go through `init` + `fetch --depth 1 <url> <sha>` + `checkout FETCH_HEAD`.
 *
 *  We do not decide which one `<x>` is by looking at it. `/^[0-9a-f]{7,40}$/` is a guess, and a wrong guess
 *  here installs the wrong tree silently: `abcdef` is a perfectly legal branch name, and a repository that
 *  has one would be pinned to a commit that merely shares the spelling. Git's answer is a fact, so we ask
 *  git: try the branch form, and use the commit form only when that fails.
 *
 *  ORDER IS A DECISION, not a side effect. When a name is BOTH a branch and the short id of some commit,
 *  the branch wins, because someone typing `--ref` almost always means a name. That is why the branch form
 *  is tried first, and the manifest records `resolvedBy` so the question "was this a branch or a commit?"
 *  has an answer afterwards rather than a shrug.
 *
 *  One deliberate refusal: fetching a bare SHA needs `uploadpack.allowReachableSHA1InWant` on the server,
 *  and plenty of hosts leave it off. When that is refused we STOP and say so. The alternative — quietly
 *  dropping `--depth` and cloning the entire history — turns a pin into a very long download the person
 *  did not ask for, and they would have no idea why. */

export type Spawn = (cmd: string[], cwd: string) => Promise<{ code: number; stderr: string }>;

export type ResolvedBy = "branch" | "commit" | "default";

export interface CloneResult {
  ok: true;
  /** which form of the command actually produced the tree */
  resolvedBy: ResolvedBy;
}
export type CloneOutcome = CloneResult | { ok: false; error: string };

/** the last line of git's complaint, which is the part a person can act on */
const lastLine = (stderr: string): string => stderr.trim().split("\n").at(-1)?.trim() ?? "";

/** a server that will not serve a bare commit says so in one of a few ways; all of them mean the same
 *  thing to us, and none of them should be answered by fetching more */
function refusesBareSha(stderr: string): boolean {
  return /allow.*sha1.*in.?want|not our ref|unadvertised object|Server does not allow request for unadvertised object/i.test(stderr);
}

/** Clone `url` into `dir` (which must exist and be empty), optionally at `ref`. */
/** `--` before every positional, on purpose. git parses options wherever it finds them, so a value that
 *  begins with a dash is read as an option no matter which slot it sits in: a ref or a URL spelled
 *  `--upload-pack=...` becomes an instruction rather than a name. Catalog data cannot reach here in that
 *  shape (`url()` filters it), but `market install <git-url>` and `--ref` come straight from a command
 *  line. The marker costs one argument and says "what follows is a value", which is the claim we mean. */
export async function cloneAtRef(spawn: Spawn, url: string, dir: string, ref?: string): Promise<CloneOutcome> {
  if (ref === undefined || ref.trim() === "") {
    const r = await spawn(["git", "clone", "--depth", "1", "--quiet", "--", url, "."], dir);
    return r.code === 0 ? { ok: true, resolvedBy: "default" } : { ok: false, error: `git clone failed (exit ${r.code})${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}` };
  }

  // 1. a branch or a tag — the common case, and the winner when a name is both
  const branch = await spawn(["git", "clone", "--depth", "1", "--quiet", "--branch", ref, "--", url, "."], dir);
  if (branch.code === 0) return { ok: true, resolvedBy: "branch" };

  // 2. a commit. Not a fallback for "anything went wrong": if the failure was the network or auth, the
  //    fetch will fail the same way and we report THAT, not a misleading "no such ref".
  const init = await spawn(["git", "init", "--quiet"], dir);
  if (init.code !== 0) return { ok: false, error: `git init failed (exit ${init.code})${lastLine(init.stderr) ? `: ${lastLine(init.stderr)}` : ""}` };
  const fetch = await spawn(["git", "fetch", "--depth", "1", "--quiet", "--", url, ref], dir);
  if (fetch.code !== 0) {
    if (refusesBareSha(fetch.stderr)) {
      return { ok: false, error: `${url} will not serve the single commit ${ref} (the server has uploadpack.allowReachableSHA1InWant off) — give a branch or tag instead, or ask the host to enable it` };
    }
    return { ok: false, error: `"${ref}" is not a branch or tag there, and fetching it as a commit failed (exit ${fetch.code})${lastLine(fetch.stderr) ? `: ${lastLine(fetch.stderr)}` : ""}` };
  }
  const checkout = await spawn(["git", "checkout", "--quiet", "FETCH_HEAD"], dir);
  if (checkout.code !== 0) return { ok: false, error: `fetched ${ref} but could not check it out (exit ${checkout.code})${lastLine(checkout.stderr) ? `: ${lastLine(checkout.stderr)}` : ""}` };
  return { ok: true, resolvedBy: "commit" };
}
