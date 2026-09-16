/** `rovecode connect` — one line from "nothing configured" to "a model answers".
 *
 *    rovecode connect                                  the step-by-step wizard (cli/setup.ts)
 *    rovecode connect anthropic                        a built-in: key from the env, else a hidden prompt
 *    rovecode connect anthropic --model claude-opus-5  pin the model too
 *    rovecode connect ollama --no-key                  a local server, nothing to store
 *    rovecode connect myproxy https://host/v1 --key    any OpenAI-compatible or Anthropic URL
 *    echo $KEY | rovecode connect groq --key-stdin     scripts and CI: no TTY needed
 *
 *  It does what `setup` does — register, store the key, pick the model, one tiny real call, persist the
 *  default — but takes the answers from argv instead of asking, so it fits in a README, a Dockerfile or
 *  a CI step. `rovecode connect` with no arguments is exactly `rovecode setup`.
 *
 *  The secret is never a flag VALUE: `--key` prompts (hidden, TTY), `--key-stdin` reads one line, and
 *  `--key-env NAME` names an env var to read at call time. A key passed as argv would sit in the shell
 *  history and in every `ps` listing on the machine, so there is no `--key <value>` form.
 *
 *  Every step reads through an injectable seam (secret / stdin / save / probe / out) so the whole flow
 *  is unit-testable with no network and no terminal.
 *
 *  Exit codes: 0 connected · 1 the test call failed (the config IS written — a script should notice) ·
 *  2 usage error / no key available and no way to ask · 3 CONNECT_WAITING, only when the caller passed
 *  `deferKey`: the provider is registered and the flow is parked until the key lands (the TUI, which has
 *  no masked input, arms a watcher and re-enters). Wording: core/voice.ts — short lines, every problem
 *  ends with "→ next:". */

import { readSecret, saveCredential } from "../providers/auth.ts";
import { PROVIDER_ID_RE, inferProtocol, isConfigured, type ProviderProtocol, type ProviderSpec, type ResolvedProvider } from "../providers/provider-config.ts";
import type { FileScope } from "../providers/provider-config.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { next } from "../core/voice.ts";
import type { ProbeResult } from "./setup.ts";

/** returned instead of an error when `deferKey` handles the missing key: nothing failed, the flow is parked */
export const CONNECT_WAITING = 3;

export const CONNECT_USAGE =
  "usage: rovecode connect [<id> [<baseUrl>]] [--model <id>] [--key | --key-stdin | --key-env NAME | --no-key] [--protocol openai|anthropic] [--project] [--no-test]";

export interface ConnectArgs {
  id: string;
  baseUrl?: string;
  model?: string;
  protocol?: ProviderProtocol;
  /** how the key is obtained; "auto" = stored/env if there is one, else prompt when a TTY allows it */
  key: "auto" | "prompt" | "stdin" | "none";
  keyEnv?: string;
  scope: FileScope;
  test: boolean;
}

/** argv → ConnectArgs. Pure: no files, no env, no network — the parser is the half worth pinning. */
export function parseConnectArgs(words: readonly string[]): ConnectArgs | { error: string } {
  const pos: string[] = [];
  let model: string | undefined;
  let protocol: ProviderProtocol | undefined;
  let keyEnv: string | undefined;
  let key: ConnectArgs["key"] = "auto";
  let scope: FileScope = "user";
  let test = true;
  const keyFlags: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const value = (): string | undefined => { const v = words[i + 1]; if (v === undefined || v.startsWith("-")) return undefined; i++; return v; };
    switch (w) {
      case "--model": { const v = value(); if (v === undefined) return { error: `--model needs a value — ${CONNECT_USAGE}` }; model = v; break; }
      case "--key-env": { const v = value(); if (v === undefined) return { error: `--key-env needs a value — ${CONNECT_USAGE}` }; keyEnv = v; keyFlags.push(w); break; }
      case "--protocol": {
        const v = value();
        if (v !== "openai" && v !== "anthropic") return { error: `--protocol takes openai or anthropic — ${CONNECT_USAGE}` };
        protocol = v; break;
      }
      case "--key": key = "prompt"; keyFlags.push(w); break;
      case "--key-stdin": key = "stdin"; keyFlags.push(w); break;
      case "--no-key": key = "none"; keyFlags.push(w); break;
      case "--project": scope = "project"; break;
      case "--no-test": test = false; break;
      default:
        if (w.startsWith("-")) return { error: `unknown flag ${w} — ${CONNECT_USAGE}` };
        pos.push(w);
    }
  }

  // --key-env names an env var to read; --key/--key-stdin store a secret; --no-key stores nothing.
  // Two of them together is a contradiction, not a precedence puzzle — say so instead of picking one.
  if (keyFlags.length > 1) return { error: `${keyFlags.join(" and ")} contradict each other — pick one` };
  if (pos.length === 0) return { error: `connect needs a provider id — ${CONNECT_USAGE}` };
  if (pos.length > 2) return { error: `unexpected argument "${pos[2]}" — ${CONNECT_USAGE}` };

  const id = pos[0]!.toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) return { error: `"${id}" won't work as an id (letters, digits, - _ .)` };
  const baseUrl = pos[1];
  if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) return { error: `"${baseUrl}" is not an http(s) URL — ${CONNECT_USAGE}` };
  if (baseUrl === undefined && protocol !== undefined) return { error: "--protocol only applies when you give a base URL" };

  return { id, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(model !== undefined ? { model } : {}),
           ...(protocol !== undefined ? { protocol } : {}), ...(keyEnv !== undefined ? { keyEnv } : {}), key, scope, test };
}

export interface ConnectDeps {
  registry: ProviderRegistry;
  /** default console.log */
  out?: (line: string) => void;
  /** one secret, masked (default: auth.ts readSecret) */
  secret?: (prompt: string) => Promise<string>;
  /** one line of piped stdin, for --key-stdin (default: reads process.stdin to end) */
  stdin?: () => Promise<string>;
  /** default auth.ts saveCredential */
  save?: (id: string, secret: string, keyEnv: string) => void;
  /** default registry.probe — one tiny real call */
  probe?: (id: string, model?: string) => Promise<ProbeResult>;
  /** default process.stdin.isTTY === true; a pipe must never be consumed by a prompt */
  tty?: boolean;
  /** a surface with no masked input (the TUI): called instead of failing when the key is missing and
   *  cannot be asked for. It owns the hand-off wording and the waiting; runConnect returns CONNECT_WAITING. */
  deferKey?: (spec: ResolvedProvider) => void;
  /** the closing line(s). Default is the CLI's; the TUI passes its own ("tell me what you want done"). */
  done?: string;
  /** which surface the "→ next:" steps are spelled for — `rovecode provider test` on a shell,
   *  `/provider test` in the TUI (core/voice.ts noModelHint uses the same distinction) */
  where?: "cli" | "tui";
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runConnect(args: ConnectArgs, deps: ConnectDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const secret = deps.secret ?? ((p: string) => readSecret(p));
  const stdin = deps.stdin ?? readAllStdin;
  const save = deps.save ?? saveCredential;
  const reg = deps.registry;
  const probe = deps.probe ?? ((id: string, model?: string) => reg.probe(id, model));
  const tty = deps.tty ?? process.stdin.isTTY === true;
  const tui = deps.where === "tui";

  // ---- 1. the provider ----
  // A base URL registers (or re-registers) the endpoint. Without one the id must already be known —
  // built-in or previously added — and --no-key/--key-env/--model still write a user entry over it,
  // which is how a built-in row becomes a local keyless server (setup.ts does the same thing).
  const existing = reg.get(args.id);
  const patching = args.key === "none" || args.keyEnv !== undefined;
  if (args.baseUrl !== undefined || patching) {
    const baseUrl = args.baseUrl ?? existing?.baseUrl;
    if (baseUrl === undefined) {
      out(`◆ I don't know a provider called "${args.id}".`);
      out(`  known: ${reg.ids().join(" ")}`);
      out(`  ${next(`rovecode connect ${args.id} <baseUrl>`)} to register your own endpoint`);
      return 2;
    }
    const protocol = args.protocol ?? existing?.protocol ?? inferProtocol(baseUrl);
    const defaultModel = args.model ?? existing?.defaultModel;
    const spec: ProviderSpec = {
      id: args.id, baseUrl, protocol,
      ...(args.keyEnv !== undefined ? { keyEnv: args.keyEnv } : existing?.keyEnv !== undefined && args.baseUrl === undefined ? { keyEnv: existing.keyEnv } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(args.key === "none" ? { noKey: true } : {}),
    };
    const r = reg.add(spec, args.scope);
    if ("error" in r) { out(`◆ ${r.error}`); out(`  ${next("rovecode connect")} for the step-by-step version`); return 2; }
    out(`◆ ${r.id} registered (${r.protocol} protocol, ${r.baseUrl}${args.key === "none" ? ", no key" : ""}).`);
  } else if (existing === undefined) {
    out(`◆ I don't know a provider called "${args.id}".`);
    out(`  known: ${reg.ids().join(" ")}`);
    out(`  ${next(`rovecode connect ${args.id} <baseUrl>`)} to register your own endpoint`);
    return 2;
  }

  const spec = reg.get(args.id);
  if (spec === undefined) { out(`◆ ${args.id} did not survive registration — that is a bug.`); return 2; }

  // ---- 2. the key ----
  let hasKey = isConfigured(spec);
  if (!hasKey || args.key === "prompt" || args.key === "stdin") {
    if (args.key === "stdin") {
      const s = (await stdin()).split("\n")[0]!.trim();
      if (s.length === 0) { out(`◆ nothing came in on stdin — no key stored.`); out(`  ${next(`echo $KEY | rovecode connect ${args.id} --key-stdin`)}`); return 2; }
      save(args.id, s, spec.keyEnv);
      out(`◆ key stored for ${args.id} (hidden; ~/.rovecode/credentials.json).`);
      hasKey = true;
    } else if (args.key === "prompt" || (args.key === "auto" && tty)) {
      const s = (await secret(`${spec.keyEnv} (hidden): `)).trim();
      if (s.length === 0) {
        out(`◆ no key stored — I can't call ${args.id} without one.`);
        out(`  ${next(`rovecode auth set ${args.id}`)}   (or set ${spec.keyEnv} in your environment)`);
        return 2;
      }
      save(args.id, s, spec.keyEnv);
      out(`◆ key stored for ${args.id} (hidden; ~/.rovecode/credentials.json).`);
      hasKey = true;
    } else if (deps.deferKey !== undefined) {
      // a surface that cannot prompt (the TUI) takes over: it says how to hand the key over and
      // finishes this same call once the key lands
      deps.deferKey(spec);
      return CONNECT_WAITING;
    } else {
      // no key anywhere and no terminal to ask on: a pipe must not be consumed by a prompt
      out(`◆ ${args.id} has no key, and there is no terminal to ask on.`);
      out(`  ${next(`set ${spec.keyEnv}, or pipe it: echo $KEY | rovecode connect ${args.id} --key-stdin`)}`);
      return 2;
    }
  } else {
    out(spec.noKey === true
      ? `◆ ${args.id} needs no key (local server).`
      : `◆ ${args.id} already has a key (${spec.keySource === "stored" ? "stored" : `env ${spec.keyEnv}`}).`);
  }
  reg.refresh();

  // ---- 3. the model ----
  const model = args.model ?? reg.get(args.id)?.defaultModel;
  if (model === undefined) {
    out(`◆ ${args.id} is connected but has no model yet.`);
    out(`  ${next(tui ? `/models ${args.id}, then /model ${args.id}/<model> --save` : `rovecode model list ${args.id}, then rovecode model use ${args.id}/<model>`)}`);
    return 0;
  }

  // ---- 4. one tiny real call ----
  let ok = true;
  if (args.test) {
    out(`◆ testing ${args.id}/${model} …`);
    const r = await probe(args.id, model);
    ok = r.ok;
    out(`  ${r.detail}`);
  }

  // ---- 5. the default ----
  // written even when the probe failed: the config is what the user asked for, and `provider test`
  // is one command away. The exit code carries the failure instead.
  const d = reg.setDefault(`${args.id}/${model}`, args.scope);
  if ("error" in d) { out(`◆ ${d.error}`); out(`  ${next(`rovecode model use ${args.id}/<model>`)}`); return 2; }
  out(`◆ default → ${d.provider}/${d.model} (${tui ? "this session switched too" : "running TUIs switch live"}).`);

  if (!ok) {
    out(`  ${next(`check the key and the URL, then ${tui ? "/provider" : "rovecode provider"} test ${args.id} ${model}`)}`);
    return 1;
  }
  out("");
  out(deps.done ?? 'Done. Try:  rovecode "explain this repo"\n  or open the cockpit:  rovecode');
  return 0;
}
