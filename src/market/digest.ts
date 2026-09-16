/** What landed on disk, as one number — so "has this changed since I installed it?" has an answer.
 *
 *  `--ref` pins what we ASK for; a digest is what we GOT. The two answer different questions and the second
 *  is the one that survives: a commit id says the remote pointed there at fetch time, a digest says the
 *  bytes on this machine are still the bytes that arrived. Nobody in this space signs anything, so a
 *  recorded digest is the honest ceiling — it detects drift, it does not prove provenance, and the wording
 *  everywhere says the former.
 *
 *  Over a FOLDER, the hash covers the relative path and the content of every file, in a sorted order, so it
 *  is stable across platforms and independent of the order a directory happens to list. `.git` is excluded:
 *  it is fetch bookkeeping, it differs between a clone and a copy of the same tree, and including it would
 *  make every digest disagree with itself for no reason a person could act on.
 *
 *  Line endings are NOT normalised. A file that arrives with CRLF and later has LF is genuinely different
 *  content, and on a repository that has been through a Windows checkout that difference is exactly the
 *  kind of thing someone would want reported rather than hidden. */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Digest {
  algo: "sha256";
  /** hex */
  value: string;
  /** how many files went into it — a cheap sanity check when two digests differ */
  files: number;
}

/** Every file under `dir`, relative and slash-separated, sorted. Excludes `.git`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const here = stack.pop()!;
    let names: string[];
    try { names = readdirSync(here); } catch { continue; }
    for (const name of names) {
      if (name === ".git") continue;
      const full = join(here, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      // a symlink is never followed: install refuses them, and following one here would hash something
      // outside the folder we claim to be describing
      if (st.isDirectory()) { stack.push(full); continue; }
      if (st.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/** The digest of a file or a folder. Undefined when the path is not there — a missing thing has no
 *  digest, and pretending it has one of an empty folder would make "deleted" and "emptied" look alike. */
export function digestOf(path: string): Digest | undefined {
  if (!existsSync(path)) return undefined;
  const hash = createHash("sha256");
  let files = 0;
  try {
    if (statSync(path).isFile()) {
      hash.update(readFileSync(path));
      files = 1;
    } else {
      for (const rel of walk(path)) {
        // the PATH goes in too: moving a file's content to another name is a change
        hash.update(rel);
        hash.update("\0");
        hash.update(readFileSync(join(path, rel)));
        hash.update("\0");
        files += 1;
      }
    }
  } catch { return undefined; }
  return { algo: "sha256", value: hash.digest("hex"), files };
}

export type VerifyState =
  /** the bytes are what they were */
  | { state: "unchanged"; digest: Digest }
  /** it is still installed, and it is not what it was */
  | { state: "changed"; recorded: Digest; now: Digest }
  /** it was installed and is no longer there */
  | { state: "missing"; recorded: Digest }
  /** there is nothing recorded to compare against; not a failure */
  | { state: "unrecorded"; now?: Digest }
  /** the kind carries no digest by design (an MCP entry is a line in a shared file) */
  | { state: "not-applicable"; why: string };

/** Compare what is on disk with what was recorded. Pure over its inputs apart from reading the path. */
export function verifyDigest(recorded: Digest | undefined, path: string | undefined): VerifyState {
  if (path === undefined) return { state: "not-applicable", why: "this kind of install has no folder of its own to hash" };
  const now = digestOf(path);
  if (recorded === undefined) return now === undefined ? { state: "unrecorded" } : { state: "unrecorded", now };
  if (now === undefined) return { state: "missing", recorded };
  return now.value === recorded.value ? { state: "unchanged", digest: now } : { state: "changed", recorded, now };
}

/** One line for `market verify`, in the words the state deserves. */
export function verifyLine(id: string, v: VerifyState): string {
  switch (v.state) {
    case "unchanged": return `${id}  unchanged (${v.digest.files} file${v.digest.files === 1 ? "" : "s"})`;
    case "changed": return `${id}  CHANGED since install — recorded ${v.recorded.value.slice(0, 12)} (${v.recorded.files} files), now ${v.now.value.slice(0, 12)} (${v.now.files} files)`;
    case "missing": return `${id}  gone from disk, but a record remains`;
    case "unrecorded": return `${id}  no digest recorded — installed before rovecode kept one, or by hand`;
    case "not-applicable": return `${id}  ${v.why}`;
  }
}
