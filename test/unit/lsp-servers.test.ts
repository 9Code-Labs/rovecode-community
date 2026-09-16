/** coding/lsp-servers.ts, the pure `lsp` grammar (ported from the Nimbus harness, #73): defaults (= #13's TS/JS table),
 *  the merge over them (`ext=off` deletes, the bare `off` empties), extension normalisation, the double-quote tokenizer,
 *  every problem class, the languageId table, and rovecode's two sources (ROVECODE_LSP, then the settings `lsp` value).
 *  MUTATION TARGETS: replace instead of merge over the defaults → the merge test; drop the quote tokenizer → the quoted
 *  argv0 test; re-add an implicit `--stdio` → the default round-trip and the exact-argv rows; ignore the bare `off` → the off
 *  rows; accept a malformed table silently (lspTableProblem → null) → the problems test. No I/O, no spawn, injected maps. */

import { expect, test } from "bun:test";
import {
  DEFAULT_LSP_TABLE, DEFAULT_SERVERS, DEFAULT_SERVER_ARGV, LANGUAGE_IDS, LSP_ENV, languageIdFor, lspTableProblem, lspTableValue,
  normalizeExt, parseServerTable, resolveServerTable, tokenizeArgv,
} from "../../src/coding/lsp-servers.ts";

const TS = ["typescript-language-server", "--stdio"];
const EIGHT = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"];
const env = (v: string) => ({ env: { ROVECODE_LSP: v } });

test("resolveServerTable({env:{}}) is DEFAULT_SERVERS: the eight TS/JS extensions → typescript-language-server --stdio; blank / whitespace / the documented default string all resolve to it", () => {
  const t = resolveServerTable({ env: {} });
  expect([...t.keys()].sort()).toEqual(EIGHT);
  for (const argv of t.values()) expect(argv).toEqual(TS);
  expect(DEFAULT_SERVER_ARGV).toEqual(TS);
  expect(DEFAULT_SERVERS.size).toBe(8);
  expect(resolveServerTable(env(""))).toEqual(t);
  expect(resolveServerTable(env(" \n\t "))).toEqual(t);
  expect(resolveServerTable(env(DEFAULT_LSP_TABLE))).toEqual(t); // MUTATION TARGET: an implicit --stdio doubles the flag here
  expect(DEFAULT_LSP_TABLE).toBe(".ts,.tsx,.mts,.cts,.js,.jsx,.mjs,.cjs=typescript-language-server --stdio");
  expect(LSP_ENV).toBe("ROVECODE_LSP");
});

test("merge over the defaults: '.py=pyright-langserver --stdio' adds Python (9 entries, .ts untouched); '.ts,.tsx=off' removes exactly those two; an override of a default extension replaces its argv; the bare 'off' → empty map", () => {
  const py = resolveServerTable(env(".py=pyright-langserver --stdio"));
  expect(py.size).toBe(9);
  expect(py.get(".py")).toEqual(["pyright-langserver", "--stdio"]);
  expect(py.get(".ts")).toEqual(TS); // MUTATION TARGET: replace instead of merge → undefined
  expect([...py.keys()].filter((k) => k !== ".py").sort()).toEqual(EIGHT);
  const two = resolveServerTable(env(".ts,.tsx=off"));
  expect(two.size).toBe(6);
  expect([two.has(".ts"), two.has(".tsx"), two.has(".js"), two.has(".mts")]).toEqual([false, false, true, true]);
  expect(resolveServerTable(env(".ts=my-ts-server --lsp")).get(".ts")).toEqual(["my-ts-server", "--lsp"]);
  expect(resolveServerTable(env(".ts=my-ts-server --lsp")).get(".tsx")).toEqual(TS); // siblings keep the default
  expect(resolveServerTable(env("off")).size).toBe(0); // MUTATION TARGET: ignore the bare off → 8
  expect(resolveServerTable(env(" OFF ")).size).toBe(0);
  expect(parseServerTable("off")).toEqual({ table: new Map(), off: true, problems: [] });
  expect(parseServerTable("").off).toBe(false);
});

test("sources: ROVECODE_LSP when defined (even '') beats the settings value; the settings value applies when the env is unset; neither → the defaults, and lspTableValue names the source", () => {
  expect(resolveServerTable({ env: {}, settings: ".py=x" }).get(".py")).toEqual(["x"]);
  expect(resolveServerTable({ env: { ROVECODE_LSP: ".py=y" }, settings: ".py=x" }).get(".py")).toEqual(["y"]);
  expect(resolveServerTable({ env: { ROVECODE_LSP: "" }, settings: ".py=x" }).has(".py")).toBe(false); // defined-empty env = the defaults
  expect(resolveServerTable({ env: { ROVECODE_LSP: "off" }, settings: ".py=x" }).size).toBe(0);
  expect(resolveServerTable({ env: {} }).size).toBe(8);
  expect(lspTableValue({ env: {}, settings: ".py=x" })).toEqual({ value: ".py=x", source: "settings" });
  expect(lspTableValue({ env: { ROVECODE_LSP: "" }, settings: ".py=x" })).toEqual({ value: "", source: "env" });
  expect(lspTableValue({ env: {} })).toEqual({ value: "", source: "default" });
  // an unrelated env key is not the knob
  expect(resolveServerTable({ env: { NIMBUS_LSP: ".py=x", AION_LSP: ".py=x" } }).has(".py")).toBe(false);
});

test("normalisation: 'py' / '.PY' / ' .Py ' → .py; '.py,.pyi=x' sets both; entries split on ';' (a trailing ';' is tolerated); a mixed table applies every entry", () => {
  expect([normalizeExt("py"), normalizeExt(".PY"), normalizeExt(" .Py "), normalizeExt("c++"), normalizeExt("h_1")]).toEqual([".py", ".py", ".py", ".c++", ".h_1"]);
  expect([normalizeExt(""), normalizeExt("."), normalizeExt("a b"), normalizeExt("a/b"), normalizeExt("*")]).toEqual([null, null, null, null, null]);
  expect(resolveServerTable(env("py=a")).get(".py")).toEqual(["a"]);
  expect(resolveServerTable(env(".PY=a")).get(".py")).toEqual(["a"]);
  const both = parseServerTable(".py,.pyi=x --y");
  expect(both.problems).toEqual([]);
  expect([...both.table.entries()]).toEqual([[".py", ["x", "--y"]], [".pyi", ["x", "--y"]]]);
  const mixed = resolveServerTable(env(" .py = pyright-langserver --stdio ; .ts,.tsx=off; rs = rust-analyzer ; "));
  expect(mixed.get(".py")).toEqual(["pyright-langserver", "--stdio"]);
  expect(mixed.get(".rs")).toEqual(["rust-analyzer"]);
  expect([mixed.has(".ts"), mixed.has(".tsx"), mixed.has(".js")]).toEqual([false, false, true]);
  expect(mixed.size).toBe(8);
});

test("tokenizer: whitespace split; double quotes group a path with spaces (argv0 = 'C:\\Program Files\\x\\srv.exe'); quotes may wrap part of a token; tabs split; an unbalanced quote is null", () => {
  expect(tokenizeArgv('"C:\\Program Files\\x\\srv.exe" --stdio')).toEqual(["C:\\Program Files\\x\\srv.exe", "--stdio"]);
  expect(tokenizeArgv("a  b\tc")).toEqual(["a", "b", "c"]);
  expect(tokenizeArgv('pre"fix ed" tail')).toEqual(["prefix ed", "tail"]);
  expect(tokenizeArgv('a "" b')).toEqual(["a", "", "b"]);
  expect(tokenizeArgv('"unbalanced')).toBeNull();
  expect(tokenizeArgv("")).toEqual([]);
  expect(tokenizeArgv("   ")).toEqual([]);
  const t = parseServerTable('.py="C:\\Program Files\\x\\srv.exe" --stdio');
  expect(t.problems).toEqual([]);
  expect(t.table.get(".py")).toEqual(["C:\\Program Files\\x\\srv.exe", "--stdio"]); // MUTATION TARGET: drop the quote tokenizer → 3 tokens
  expect(resolveServerTable(env('.py="/opt/my tools/pyright" --stdio --verbose')).get(".py")).toEqual(["/opt/my tools/pyright", "--stdio", "--verbose"]);
});

test("problems: unbalanced quote / empty argv / missing '=' / bad extension / duplicate extension → lspTableProblem names the entry; valid, blank, ext=off and the bare off → null; every problem of a value is collected", () => {
  expect(lspTableProblem('.py="a b')).toMatch(/entry "\.py="a b": unbalanced double quote/);
  expect(lspTableProblem(".py=")).toMatch(/entry ".py=": empty argv/);
  expect(lspTableProblem(".py=   ")).toContain("empty argv");
  expect(lspTableProblem("pyright-langserver --stdio")).toMatch(/entry "pyright-langserver --stdio" has no "="/);
  expect(lspTableProblem("=x")).toContain("is not a file extension");
  expect(lspTableProblem(".p y=x")).toContain('".p y" is not a file extension');
  expect(lspTableProblem("a/b=x")).toContain("is not a file extension");
  expect(lspTableProblem(".py=a;.py=b")).toContain(".py is listed twice");
  expect(lspTableProblem(".py,py=a")).toContain(".py is listed twice");
  expect(lspTableProblem("garbage")).not.toBeNull(); // MUTATION TARGET: accept a malformed table silently
  expect(lspTableProblem("true")).not.toBeNull();
  expect(lspTableProblem(".py=pyright-langserver --stdio")).toBeNull();
  expect(lspTableProblem("")).toBeNull();
  expect(lspTableProblem("   ")).toBeNull();
  expect(lspTableProblem("off")).toBeNull();
  expect(lspTableProblem(".ts=off;.py=x")).toBeNull();
  expect(lspTableProblem(DEFAULT_LSP_TABLE)).toBeNull();
  const many = parseServerTable(".py=;.rs;.go=ok");
  expect(many.problems.length).toBe(2);
  expect(many.table.get(".go")).toEqual(["ok"]); // the valid entry still parses (the gate applies it for an env value)
  expect(lspTableProblem(".py=;.rs")).toBe(many.problems.join("; "));
});

test("languageIdFor: .py→python, .ts→typescript, .tsx→typescriptreact, .rs→rust, .go→go, .PY→python (case), .zz→zz (bare extension), ''→plaintext; the TS/JS ids equal #13's", () => {
  expect([".py", ".ts", ".tsx", ".rs", ".go", ".PY", ".zz", "", ".", ".pyi"].map(languageIdFor)).toEqual([
    "python", "typescript", "typescriptreact", "rust", "go", "python", "zz", "plaintext", "plaintext", "python",
  ]);
  expect([".ts", ".mts", ".cts"].map((e) => LANGUAGE_IDS[e])).toEqual(["typescript", "typescript", "typescript"]);
  expect([".js", ".mjs", ".cjs", ".jsx", ".tsx"].map((e) => LANGUAGE_IDS[e])).toEqual(["javascript", "javascript", "javascript", "javascriptreact", "typescriptreact"]);
  for (const [ext, id] of Object.entries(LANGUAGE_IDS)) expect([ext, /^\.[a-z0-9]+$/.test(ext), /^[a-z]+$/.test(id)]).toEqual([ext, true, true]);
  expect(Object.keys(LANGUAGE_IDS).length).toBeGreaterThan(30);
});
