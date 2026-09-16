/** Fixtures for the port #72 skills tests (test/unit/skills-spec.test.ts, skills-cmd*.test.ts,
 *  test/integration/skills-cli.test.ts): a spec-shaped skill factory (every agentskills.io field, the bundled
 *  scripts/ references/ assets/ dirs, an optional decoy references/example/SKILL.md), a hand-crafted tar.gz builder
 *  for the unsafe-key pins (craftArchive), a raw ustar writer whose member TYPES the test chooses (craftTar — symlink /
 *  hard-link / directory pins), an io collector, and ONE loopback Bun.serve per test file that serves a registered
 *  archive, a 500 and a non-archive body while counting hits. No tests live here; no module-level scratch dirs. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillsCmdIo } from "../../src/cli/skills-cmd.ts";

/** exactly 1024 characters, ending in a letter (an inline frontmatter value is trimmed) */
export const LONG_DESCRIPTION = `${"Extracts text and tables from PDF files, fills forms and merges documents. ".repeat(20).slice(0, 1023)}x`;

export interface SpecSkillOptions {
  /** the frontmatter `name:`; null omits the line (default "pdf-processing") */
  name?: string | null;
  /** the directory name (default: the name, or "pdf-processing") */
  dirName?: string;
  /** null omits the line (default LONG_DESCRIPTION) */
  description?: string | null;
  /** a top-level `version:` line (absent by default — the metadata.version fallback carries the version) */
  version?: string;
  metadataVersion?: string;
  compatibility?: string;
  /** raw extra lines inside the block */
  extra?: string[];
  /** the `x-custom:` unknown key (default true → exactly one loader warning) */
  unknownKey?: boolean;
  /** scripts/run.sh, references/a.md, assets/logo.txt (default true) */
  resources?: boolean;
  /** references/example/SKILL.md — must NOT load as a second skill */
  decoy?: boolean;
  body?: string;
}

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `---\nname: <name>\ndescription: …\n---` + a body — the minimal valid skill */
export function skillMd(name: string, description = "does the thing"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`;
}

/** Writes `<root>/<dir>/SKILL.md` with the full spec field set (+ resources); returns the skill dir. */
export function mkSpecSkill(root: string, o: SpecSkillOptions = {}): string {
  const name = o.name === undefined ? "pdf-processing" : o.name;
  const dir = join(root, o.dirName ?? name ?? "pdf-processing");
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (name !== null) lines.push(`name: ${name}`);
  if (o.description !== null) lines.push(`description: ${o.description ?? LONG_DESCRIPTION}`);
  lines.push("license: Apache-2.0", `compatibility: ${o.compatibility ?? "Requires python3 and the pdfplumber package"}`);
  lines.push("metadata:", "  author: rovecode-tests", `  version: ${o.metadataVersion ?? "1.2.3"}`);
  if (o.version !== undefined) lines.push(`version: ${o.version}`);
  lines.push("allowed-tools: read bash grep");
  if (o.unknownKey !== false) lines.push("x-custom: whatever");
  if (o.extra) lines.push(...o.extra);
  lines.push("---", "", o.body ?? "# PDF processing\n\nRun scripts/run.sh against the PDF.", "");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  if (o.resources !== false) {
    write(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho run\n");
    write(join(dir, "references", "a.md"), "# ref\n");
    write(join(dir, "assets", "logo.txt"), "logo\n");
  }
  if (o.decoy) write(join(dir, "references", "example", "SKILL.md"), "---\nname: example\ndescription: a decoy\n---\nnot a skill\n");
  return dir;
}

/** a gzip tarball with exactly these entries — keys verbatim, so the unsafe pins can carry `../x`, `C:/x`, … */
export function craftArchive(entries: Record<string, string>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const data: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) data[k] = enc.encode(v);
  return new Bun.Archive(data, { compress: "gzip" }).bytes();
}

export interface TarMember {
  name: string;
  /** ustar typeflag: "0" file (default) · "1" hard link · "2" symlink · "3" / "4" device · "5" directory · "6" fifo · "x" pax header */
  type?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "x";
  data?: string;
  link?: string;
}

/** A hand-built ustar tarball (gzip unless `gzip` is false) — Bun.Archive's constructor writes regular files only, so
 *  the member-type pins need raw 512-byte headers: name, mode, size (octal), checksum, typeflag, linkname, `ustar\0` `00`. */
export function craftTar(members: TarMember[], gzip = true): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const m of members) {
    const data = enc.encode(m.data ?? "");
    const h = new Uint8Array(512);
    const put = (off: number, s: string): void => { h.set(enc.encode(s), off); };
    put(0, m.name); put(100, "0000644\0"); put(108, "0000000\0"); put(116, "0000000\0");
    put(124, `${data.length.toString(8).padStart(11, "0")}\0`); put(136, "00000000000\0"); put(148, "        ");
    put(156, m.type ?? "0"); put(157, m.link ?? ""); put(257, "ustar\0"); put(263, "00");
    put(148, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) { tar.set(b, off); off += b.length; }
  return gzip ? Bun.gzipSync(tar) : tar;
}

/** An io collector: cmdSkills writes lines, the test reads them. */
export function collectIo(): { io: SkillsCmdIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

export interface SkillsFixture {
  baseUrl: string;
  /** pathname → count */
  hits: Record<string, number>;
  /** the bytes `/skill.tar.gz` serves */
  setArchive(bytes: Uint8Array): void;
  stop(): void;
}

/** ONE loopback server per test file: /skill.tar.gz (the registered archive), /500, /html (not an archive), else 404. */
export function startSkillsFixture(): SkillsFixture {
  const hits: Record<string, number> = {};
  let archive: Uint8Array = new Uint8Array(0);
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      switch (path) {
        case "/skill.tar.gz": return new Response(archive as BodyInit, { headers: { "content-type": "application/gzip" } });
        case "/500": return new Response("boom", { status: 500 });
        case "/html": return new Response("<html>not a tarball</html>", { headers: { "content-type": "text/html" } });
        default: return new Response("not found", { status: 404 });
      }
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`, hits,
    setArchive: (b) => { archive = b; },
    stop: () => { server.stop(true); },
  };
}
