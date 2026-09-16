/** Repo map (PORT #12): fills the RESERVED `repo-map` context chunk (ADR-007,
 *  order system>files>repo-map>skills>history). Port of aider's repomap.py
 *  (Apache-2.0, snapshot research/source_snapshots/Aider-AI-aider):
 *    - Tag shape + mtime-keyed tags cache ... repomap.py L29, L233-264
 *    - persistent tags cache ................ repomap.py L217-222 (-> repomap-cache.ts)
 *    - def/ref classification ............... repomap.py L318-336
 *    - def/ref graph + ident multipliers .... repomap.py L365-514
 *    - PageRank + rank->definition spread ... repomap.py L519-550
 *    - ranked file append ................... repomap.py L560-574
 *    - binary-search token budgeting ........ repomap.py L666-706
 *    - grouped tree rendering ............... repomap.py L748-784
 *    - no-source early return ............... repomap.py L113-114
 *  Symbol extraction uses @ast-grep/napi (tree-sitter) instead of aider's
 *  .scm tag queries; deviations recorded in the port report. File enumeration
 *  (git ls-files preferred, bounded walk fallback) lives in repomap-files.ts. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, extname } from "node:path";
import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { estimateTokens, type ContextChunk } from "../core/context.ts";
import { TagsDiskCache } from "./repomap-cache.ts";
import { findSrcFiles, findSrcFilesAsync, LANG_BY_EXT, MAX_SRC_FILES, type SrcScanStats } from "./repomap-files.ts";

export { findSrcFiles, findSrcFilesAsync, MAX_SRC_FILES, MAX_SRC_BYTES, type SrcScanStats } from "./repomap-files.ts";

/** one turn of the event loop — the cooperative build's yield (a frame loop paints, a key is read) */
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
/** how long the cooperative build works between two yields */
const SLICE_MS = 12;

/** repomap.py L29: Tag = namedtuple("Tag", "rel_fname fname line name kind") */
export interface Tag {
  relFname: string;
  fname: string;
  line: number; // 0-based, like tree-sitter start_point[0] (repomap.py L333)
  name: string;
  kind: "def" | "ref";
}

// ---------------------------------------------------------------- extraction

/** def-bearing node kinds with a `name` field (tree-sitter-javascript grammar). */
const DEF_KINDS_JS = [
  "function_declaration", "generator_function_declaration",
  "class_declaration", "method_definition", "variable_declarator",
];
/** TS grammar additions (tree-sitter-typescript). */
const DEF_KINDS_TS = [
  ...DEF_KINDS_JS,
  "abstract_class_declaration", "interface_declaration", "type_alias_declaration",
  "enum_declaration", "internal_module", "function_signature", "method_signature",
  "abstract_method_signature",
];
/** variable_declarator only counts as a def when its value is a function. */
const FN_VALUE_KINDS = new Set(["arrow_function", "function_expression", "generator_function"]);
/** parents where a type_identifier IS the definition name, not a reference. */
const TYPE_DEF_PARENTS = new Set([
  "class_declaration", "abstract_class_declaration", "interface_declaration",
  "type_alias_declaration",
]);

/** Extract def/ref Tags from one source file (aider get_tags_raw L279-336;
 *  kinds replace aider's *-tags.scm captures: name.definition.* -> def,
 *  name.reference.* -> ref, repomap.py L318-324). */
export function extractTags(fname: string, relFname: string, source: string): Tag[] {
  const lang = LANG_BY_EXT[extname(fname).toLowerCase()];
  if (lang === undefined) return [];
  const isTs = lang !== Lang.JavaScript;
  let root: SgNode;
  try {
    root = parse(lang, source).root();
  } catch {
    return []; // aider: "Skipping file" on parser errors (repomap.py L287-289)
  }
  const tags: Tag[] = [];
  const push = (kind: "def" | "ref", node: SgNode | null) => {
    if (!node) return;
    tags.push({ relFname, fname, line: node.range().start.line, name: node.text(), kind });
  };
  for (const kind of isTs ? DEF_KINDS_TS : DEF_KINDS_JS) {
    for (const n of root.findAll({ rule: { kind } })) {
      if (kind === "variable_declarator" && !FN_VALUE_KINDS.has(String(n.field("value")?.kind() ?? ""))) continue;
      push("def", n.field("name"));
    }
  }
  // references: call callees (aider js-tags.scm name.reference.call)
  for (const n of root.findAll({ rule: { kind: "call_expression" } })) {
    const fn = n.field("function");
    if (!fn) continue;
    push("ref", fn.kind() === "member_expression" ? fn.field("property") : fn.kind() === "identifier" ? fn : null);
  }
  // `new X()` constructor references
  for (const n of root.findAll({ rule: { kind: "new_expression" } })) push("ref", n.field("constructor"));
  // type references (TS): any type_identifier that is not a definition name
  if (isTs) {
    for (const n of root.findAll({ rule: { kind: "type_identifier" } })) {
      if (!TYPE_DEF_PARENTS.has(String(n.parent()?.kind() ?? ""))) push("ref", n);
    }
  }
  return tags;
}

// ---------------------------------------------------------------- pagerank

interface Edge { src: string; dst: string; weight: number; ident: string }

/** Weighted personalized PageRank matching networkx defaults used by aider
 *  (repomap.py L525: nx.pagerank(G, weight="weight")): alpha .85, 100 iters,
 *  L1 tolerance N*1e-6, dangling mass spread via personalization vector. */
function *pagerank(nodes: string[], edges: Edge[], personalization?: Map<string, number>): Generator<void, Map<string, number>> {
  const n = nodes.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;
  const alpha = 0.85;
  const out = new Map<string, Map<string, number>>(); // src -> dst -> summed weight
  const outTotal = new Map<string, number>();
  let work = 0;
  for (const e of edges) {
    if (++work % 1024 === 0) yield;
    const row = out.get(e.src) ?? new Map<string, number>();
    row.set(e.dst, (row.get(e.dst) ?? 0) + e.weight);
    out.set(e.src, row);
    outTotal.set(e.src, (outTotal.get(e.src) ?? 0) + e.weight);
  }
  const persTotal = [...(personalization?.values() ?? [])].reduce((a, b) => a + b, 0);
  const p = new Map(nodes.map((node) => [node, persTotal > 0 ? (personalization?.get(node) ?? 0) / persTotal : 1 / n]));
  let x = new Map(nodes.map((node) => [node, 1 / n]));
  for (let iter = 0; iter < 100; iter++) {
    const xlast = x;
    x = new Map(nodes.map((node) => [node, 0]));
    let danglesum = 0;
    for (const node of nodes) if ((outTotal.get(node) ?? 0) === 0) danglesum += alpha * (xlast.get(node) ?? 0);
    for (const node of nodes) {
      const total = outTotal.get(node) ?? 0;
      if (total === 0) continue;
      const share = alpha * (xlast.get(node) ?? 0);
      for (const [dst, w] of out.get(node)!) {
        x.set(dst, (x.get(dst) ?? 0) + share * (w / total));
        if (++work % 1024 === 0) yield;
      }
    }
    let err = 0;
    for (const node of nodes) {
      const v = (x.get(node) ?? 0) + danglesum * (p.get(node) ?? 0) + (1 - alpha) * (p.get(node) ?? 0);
      x.set(node, v);
      err += Math.abs(v - (xlast.get(node) ?? 0));
    }
    if (err < n * 1e-6) break;
  }
  return x;
}

// ---------------------------------------------------------------- repo map

/** entries are Tags or bare-file markers, mirroring aider's Tag | (fname,) tuples */
type RankedEntry = { relFname: string; tag?: Tag };

export class RepoMap {
  /** mtime-keyed in-memory tags cache (aider get_tags L233-264), backed by a
   *  persistent per-repo disk cache (aider .aider.tags.cache.v4, L217-222) so
   *  warm launches skip extraction entirely. */
  private tagsCache = new Map<string, { mtime: number; data: Tag[] }>();
  private disk: TagsDiskCache;
  /** raw extraction counter, exposed so tests can prove cache hits/misses. */
  extractCount = 0;

  constructor(readonly root: string) {
    this.disk = new TagsDiskCache(root);
  }

  /** aider get_tags (repomap.py L233-264): hit when cached mtime matches;
   *  disk hits (mtime+size) refill the in-memory map without re-extracting. */
  getTags(fname: string, relFname: string): Tag[] {
    let st;
    try {
      st = statSync(fname);
    } catch {
      return []; // file vanished (repomap.py L230-231, L235-237)
    }
    const mtime = st.mtimeMs;
    const hit = this.tagsCache.get(fname);
    if (hit && hit.mtime === mtime) return hit.data; // L246-251
    const diskHit = this.disk.get(fname, mtime, st.size);
    if (diskHit) {
      this.tagsCache.set(fname, { mtime, data: diskHit });
      return diskHit;
    }
    this.extractCount++;
    let source = "";
    try {
      source = readFileSync(fname, "utf8");
    } catch {
      return [];
    }
    const data = extractTags(fname, relFname, source);
    this.tagsCache.set(fname, { mtime, data }); // L258
    this.disk.set(fname, mtime, st.size, data);
    return data;
  }

  /** Persist the disk cache (no-op when nothing new was extracted). Callers
   *  that finish a full build should call this once — cheap, write-if-dirty. */
  saveCache(): void {
    this.disk.save();
  }

  /** aider get_ranked_tags (repomap.py L365-574). */
  rankedTags(chatFnames: string[], otherFnames: string[], mentionedIdents: Set<string>): RankedEntry[] {
    const steps = this.rankSteps(chatFnames, otherFnames, mentionedIdents);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /** Shared deterministic ranking; the async search yields while building and traversing the graph too. */
  private *rankSteps(chatFnames: string[], otherFnames: string[], mentionedIdents: Set<string>): Generator<void, RankedEntry[]> {
    let work = 0;
    const defines = new Map<string, Set<string>>();      // ident -> definer rel fnames (L370)
    const references = new Map<string, string[]>();      // ident -> referencer rel fnames (L371)
    const definitions = new Map<string, Tag[]>();        // "rel|ident" -> def tags (L372)
    const chatRel = new Set<string>();
    const fnames = [...new Set([...chatFnames, ...otherFnames])].sort(); // L379
    const relOf = (f: string) => relative(this.root, f).replaceAll("\\", "/");
    for (const fname of fnames) {
      yield;
      const rel = relOf(fname);
      if (chatFnames.includes(fname)) chatRel.add(rel);
      for (const tag of this.getTags(fname, rel)) {
        if (++work % 1024 === 0) yield;
        if (tag.kind === "def") { // L451-455
          (defines.get(tag.name) ?? defines.set(tag.name, new Set()).get(tag.name)!).add(rel);
          const key = `${rel}\0${tag.name}`;
          const list = definitions.get(key) ?? definitions.set(key, []).get(key)!;
          if (!list.some((t) => t.line === tag.line)) list.push(tag);
        } else references.get(tag.name)?.push(rel) ?? references.set(tag.name, [rel]); // L457-458
      }
    }
    if (references.size === 0) for (const [k, v] of defines) references.set(k, [...v]); // L465-466
    const edges: Edge[] = [];
    const relNodes = [...new Set(fnames.map(relOf))].sort();
    for (const [ident, definers] of defines) {
      if (references.has(ident)) continue; // self-edge only for unreferenced defs (L475-479)
      for (const definer of definers) edges.push({ src: definer, dst: definer, weight: 0.1, ident });
    }
    for (const [ident, definers] of defines) {
      if (++work % 1024 === 0) yield;
      const refs = references.get(ident);
      if (!refs) continue; // idents = defines ∩ references (L468)
      let mul = 1.0; // multipliers, repomap.py L487-499
      const isSnake = ident.includes("_") && /[a-zA-Z]/.test(ident);
      const isKebab = ident.includes("-") && /[a-zA-Z]/.test(ident);
      const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
      if (mentionedIdents.has(ident)) mul *= 10;
      if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
      if (ident.startsWith("_")) mul *= 0.1;
      if (definers.size > 5) mul *= 0.1;
      const counts = new Map<string, number>();
      for (const r of refs) {
        counts.set(r, (counts.get(r) ?? 0) + 1);
        if (++work % 1024 === 0) yield;
      }
      for (const [referencer, numRefs] of counts) // L501-514
        for (const definer of definers) {
          const useMul = chatRel.has(referencer) ? mul * 50 : mul; // L508-509
          edges.push({ src: referencer, dst: definer, weight: useMul * Math.sqrt(numRefs), ident });
          if (++work % 1024 === 0) yield;
        }
    }
    const ranked = yield* pagerank(relNodes, edges); // L525 (empty personalization here)
    // spread each node's rank across its out-edges (repomap.py L533-545)
    const rankedDefs = new Map<string, number>();
    const outTotals = new Map<string, number>();
    for (const e of edges) {
      outTotals.set(e.src, (outTotals.get(e.src) ?? 0) + e.weight);
      if (++work % 1024 === 0) yield;
    }
    for (const e of edges) {
      if (++work % 1024 === 0) yield;
      const srcRank = ranked.get(e.src) ?? 0;
      const key = `${e.dst}\0${e.ident}`;
      rankedDefs.set(key, (rankedDefs.get(key) ?? 0) + srcRank * (e.weight / outTotals.get(e.src)!));
    }
    // sort by (rank, fname, ident) all descending — python reverse=True on
    // key (x[1], x[0]) (repomap.py L548-550): deterministic tie-break
    const sortedDefs = [...rankedDefs.entries()].sort(([ka, ra], [kb, rb]) => rb - ra || (kb < ka ? -1 : kb > ka ? 1 : 0));
    const out: RankedEntry[] = [];
    for (const [key] of sortedDefs) {
      const [fname] = key.split("\0") as [string, string];
      if (chatRel.has(fname)) continue; // L556-557
      for (const tag of definitions.get(key) ?? []) out.push({ relFname: fname, tag });
    }
    // append remaining files by overall node rank, then leftovers (L560-574)
    const included = new Set(out.map((e) => e.relFname));
    const leftovers = new Set(otherFnames.map(relOf));
    const topRank = [...ranked.entries()].sort(([na, ra], [nb, rb]) => rb - ra || (nb < na ? -1 : nb > na ? 1 : 0));
    for (const [fname] of topRank) {
      leftovers.delete(fname);
      if (!included.has(fname)) { out.push({ relFname: fname }); included.add(fname); }
    }
    for (const fname of [...leftovers].sort()) out.push({ relFname: fname });
    return out;
  }

  /** aider get_ranked_tags_map_uncached binary search (repomap.py L666-706).
   *  Deviation: aider accepts trees up to 15% OVER budget (pct_err<0.15,
   *  L689-696); we only early-stop within-budget so the cap is hard. */
  rankedTagsMap(chatFnames: string[], otherFnames: string[], maxMapTokens: number, mentionedIdents = new Set<string>()): string {
    const search = this.searchTree(chatFnames, otherFnames, maxMapTokens, mentionedIdents);
    let step = search.next();
    while (!step.done) step = search.next();
    return step.value;
  }

  /** rankedTagsMap with a yield to the event loop between the binary search's iterations (each one renders
   *  a candidate tree and re-reads its files) — the same result, byte for byte */
  async rankedTagsMapAsync(chatFnames: string[], otherFnames: string[], maxMapTokens: number, mentionedIdents = new Set<string>(), signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const search = this.searchTree(chatFnames, otherFnames, maxMapTokens, mentionedIdents);
    let step = search.next();
    while (!step.done) { await yieldNow(); signal?.throwIfAborted(); step = search.next(); }
    return step.value;
  }

  /** fill the tags cache for `fnames` in SLICE_MS slices of work with a yield between them: the cold
   *  extraction (tree-sitter parse per file) is the cost of a first build — 10 s for 650 files — and
   *  this is what keeps it off the frame loop. Order and results are exactly getTags's. */
  async warmTags(fnames: readonly string[], signal?: AbortSignal): Promise<void> {
    let sliceStart = performance.now();
    for (const fname of fnames) {
      signal?.throwIfAborted();
      this.getTags(fname, relative(this.root, fname).replaceAll("\\", "/"));
      if (performance.now() - sliceStart >= SLICE_MS) { await yieldNow(); sliceStart = performance.now(); }
    }
  }

  /** the binary search of rankedTagsMap as steps: one `yield` per candidate tree, the map as the return */
  private *searchTree(chatFnames: string[], otherFnames: string[], maxMapTokens: number, mentionedIdents: Set<string>): Generator<void, string> {
    const special = this.specialEntries();
    const rankedTags = [...special, ...(yield* this.rankSteps(chatFnames, otherFnames, mentionedIdents))];
    const chatRel = new Set(chatFnames.map((f) => relative(this.root, f).replaceAll("\\", "/")));
    const numTags = rankedTags.length;
    let lowerBound = 0, upperBound = numTags, bestTree = "", bestTreeTokens = 0;
    let middle = Math.min(Math.floor(maxMapTokens / 25), numTags); // L676
    while (lowerBound <= upperBound) {
      yield;
      const tree = this.toTree(rankedTags.slice(0, middle), chatRel);
      const numTokens = estimateTokens(tree);
      const pctErr = Math.abs(numTokens - maxMapTokens) / maxMapTokens;
      if (numTokens <= maxMapTokens && numTokens > bestTreeTokens) { // L691-696
        bestTree = tree;
        bestTreeTokens = numTokens;
        if (pctErr < 0.15) break;
      }
      if (numTokens < maxMapTokens) lowerBound = middle + 1; // L698-703
      else upperBound = middle - 1;
      middle = Math.floor((lowerBound + upperBound) / 2);
    }
    return bestTree;
  }

  /** special files prepended as bare entries (repomap.py L656-662; minimal
   *  filter_important_files: root-level README* / package.json / tsconfig.json,
   *  scanned directly since findSrcFiles only yields parseable sources).
   *  Parseable extensions are EXCLUDED (round-2 F5): a readme.ts is a source
   *  file — a bare entry here would swallow its ranked definitions in toTree. */
  private specialEntries(): RankedEntry[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch { /* unreadable root -> no specials */ }
    return names.filter((f) => /^(readme.*|package\.json|tsconfig\.json)$/i.test(f)
        && LANG_BY_EXT[extname(f).toLowerCase()] === undefined)
      .sort().map((f) => ({ relFname: f }));
  }

  /** aider to_tree (repomap.py L748-784): group by file, render lines of
   *  interest. Deviation: raw source lines with gap markers instead of
   *  grep_ast TreeContext scope expansion (L725-744). */
  private toTree(entries: RankedEntry[], chatRel: Set<string>): string {
    if (entries.length === 0) return "";
    // python sorted(): tuples compare (rel_fname, fname, line, ...); bare
    // (fname,) 1-tuples sort before same-file Tags (repomap.py L759)
    const sorted = [...entries].sort((a, b) =>
      a.relFname < b.relFname ? -1 : a.relFname > b.relFname ? 1 :
      (a.tag ? 1 : 0) - (b.tag ? 1 : 0) || (a.tag && b.tag ? a.tag.line - b.tag.line : 0));
    let output = "";
    let cur: string | null = null;
    let curAbs: string | null = null;
    let lois: number[] | null = null;
    const flush = () => {
      if (cur === null) return;
      if (lois && curAbs) output += `\n${cur}:\n${this.renderLines(curAbs, lois)}`;
      else output += `\n${cur}\n`;
    };
    for (const e of sorted) {
      if (chatRel.has(e.relFname)) continue; // L760-761
      if (e.relFname !== cur) {
        flush();
        cur = e.relFname;
        curAbs = e.tag?.fname ?? null;
        lois = e.tag ? [] : null;
      }
      if (lois && e.tag) lois.push(e.tag.line);
    }
    flush();
    // truncate long lines (minified js etc.), repomap.py L782; python
    // splitlines() drops the trailing empty segment — mirror that
    const lines = output.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((l) => l.slice(0, 100)).join("\n") + "\n";
  }

  private renderLines(absFname: string, lois: number[]): string {
    let lines: string[];
    try {
      lines = readFileSync(absFname, "utf8").split("\n");
    } catch {
      return "";
    }
    const want = [...new Set(lois)].sort((a, b) => a - b);
    let out = "", prev = -2;
    for (const n of want) {
      if (n > prev + 1) out += "⋮\n";
      out += `│${lines[n] ?? ""}\n`;
      prev = n;
    }
    return out;
  }
}

// ---------------------------------------------------------------- chunk

/** Build the RESERVED `repo-map` ContextChunk (ADR-007). Priority 80 slots
 *  between files (90) and skills per system>files>repo-map>skills>history.
 *  Returns null when the budget is unusable, when the repo has NO source
 *  files (aider returns early, repomap.py L113-114 — a docs-only repo must
 *  not emit a junk specials-only chunk), or when the map renders empty.
 *  When the file cap truncated enumeration, a deterministic note line is
 *  appended INSIDE the budget. Persists the tags cache after the build.
 *  `opts.maxFiles` is a test seam only. */
export function buildRepoMapChunk(rootDir: string, budgetTokens: number, opts?: { maxFiles?: number }): ContextChunk | null {
  if (budgetTokens <= 0) return null; // aider get_repo_map L111-112
  const stats: SrcScanStats = { capped: false, viaGit: false };
  const files = findSrcFiles(rootDir, stats, opts?.maxFiles ?? MAX_SRC_FILES);
  if (files.length === 0) return null; // repomap.py L113-114
  const note = stats.capped ? `\n(repo map truncated: ${opts?.maxFiles ?? MAX_SRC_FILES}-file cap reached)\n` : "";
  const rm = new RepoMap(rootDir);
  const text = rm.rankedTagsMap([], files, Math.max(1, budgetTokens - estimateTokens(note)));
  rm.saveCache();
  if (!text.trim()) return null;
  return chunkOf(text, note);
}

/** Cooperative build: enumeration is awaited (findSrcFilesAsync), extraction runs in short slices
 *  (warmTags), graph traversal and budget search yield (rankedTagsMapAsync). Individual parses, sorts
 *  and cache serialization remain synchronous; this is not a hard real-time latency bound.
 *  Same input, same chunk — the tests pin it against the synchronous build. This is what the TUI's warm
 *  build calls (cli/runtime.ts warmRepoMap): the synchronous one froze the sextant at its first reveal
 *  step (frame + files, nothing else, no keys, no resize) for 10 s in a 650-file repo with a cold tags
 *  cache and for far longer in a home directory. */
export async function buildRepoMapChunkAsync(rootDir: string, budgetTokens: number, opts?: { maxFiles?: number; signal?: AbortSignal }): Promise<ContextChunk | null> {
  opts?.signal?.throwIfAborted();
  if (budgetTokens <= 0) return null;
  const stats: SrcScanStats = { capped: false, viaGit: false };
  const files = await findSrcFilesAsync(rootDir, stats, opts?.maxFiles ?? MAX_SRC_FILES, opts?.signal);
  if (files.length === 0) return null;
  const note = stats.capped ? `\n(repo map truncated: ${opts?.maxFiles ?? MAX_SRC_FILES}-file cap reached)\n` : "";
  const rm = new RepoMap(rootDir);
  await rm.warmTags(files, opts?.signal);
  const text = await rm.rankedTagsMapAsync([], files, Math.max(1, budgetTokens - estimateTokens(note)), new Set(), opts?.signal);
  opts?.signal?.throwIfAborted();
  rm.saveCache();
  if (!text.trim()) return null;
  return chunkOf(text, note);
}

function chunkOf(text: string, note: string): ContextChunk {
  const full = text + note;
  return { name: "repo-map", text: full, priority: 80, tokens: estimateTokens(full) };
}
