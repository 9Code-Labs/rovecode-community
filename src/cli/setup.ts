/** `rovecode setup` — connect a model in one sitting: pick a provider, name the model, paste the key
 *  (masked, via auth.ts readSecret), one tiny real call, and the pick becomes the default in
 *  ~/.rovecode/providers.json. Every step reads through an injectable seam (ask / secret / save /
 *  probe) so the whole flow is unit-testable with scripted answers and no network. Piped stdin
 *  (no TTY) prints the three-line recipe and exits 2 — a wizard must not consume a script's input.
 *  Wording: core/voice.ts rules — rovecode speaks, short lines, every problem ends with "→ next:". */

import { createInterface } from "node:readline";
import { readSecret, saveCredential } from "../providers/auth.ts";
import { PROVIDER_ID_RE, inferProtocol, isConfigured } from "../providers/provider-config.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { next, noModelHint } from "../core/voice.ts";

export interface ProbeResult { ok: boolean; model: string; detail: string }

export interface SetupDeps {
  registry: ProviderRegistry;
  /** default console.log */
  out?: (line: string) => void;
  /** one plain-text answer (default: readline on stdin, echoed) */
  ask?: (prompt: string) => Promise<string>;
  /** one secret (default: readSecret — masked on a TTY) */
  secret?: (prompt: string) => Promise<string>;
  /** default auth.ts saveCredential */
  save?: (id: string, secret: string, keyEnv: string) => void;
  /** default registry.probe (one tiny real call) */
  probe?: (id: string, model?: string) => Promise<ProbeResult>;
  /** default process.stdin.isTTY === true */
  tty?: boolean;
}

interface Pick { key: string; label: string; id?: string; local?: boolean; url?: "openai" | "anthropic" }

/** the numbered menu: the common hosted providers, the two local servers, and two "your own URL" doors */
export const SETUP_PICKS: readonly Pick[] = [
  { key: "1", id: "anthropic", label: "anthropic — Claude models" },
  { key: "2", id: "openai", label: "openai" },
  { key: "3", id: "openrouter", label: "openrouter — many models behind one key" },
  { key: "4", id: "deepseek", label: "deepseek" },
  { key: "5", id: "groq", label: "groq" },
  { key: "6", id: "ollama", label: "ollama — local, no key needed", local: true },
  { key: "7", id: "lmstudio", label: "lmstudio — local, no key needed", local: true },
  { key: "8", label: "another OpenAI-compatible URL (a proxy, vLLM, …)", url: "openai" },
  { key: "9", label: "another Anthropic-protocol URL", url: "anthropic" },
];

export const SETUP_DONE = 'Done. Try:  rovecode "explain this repo"';

/** one echoed line from the terminal — shared with main.ts's numbered model picker */
export function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    rl.question(prompt, (a) => { if (settled) return; settled = true; rl.close(); resolve(a.trim()); });
    rl.once("close", () => { if (!settled) { settled = true; resolve(""); } });
  });
}

/** exit code: 0 connected (or added with a clear next step), 2 not a TTY / cancelled / invalid input */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const ask = deps.ask ?? askLine;
  const secret = deps.secret ?? ((p: string) => readSecret(p));
  const save = deps.save ?? saveCredential;
  const reg = deps.registry;
  const probe = deps.probe ?? ((id: string, model?: string) => reg.probe(id, model));
  const tty = deps.tty ?? process.stdin.isTTY === true;

  if (!tty) { out(noModelHint("cli")); out("  (rovecode setup needs a terminal — this stdin is a pipe)"); return 2; }

  out("◆ rovecode setup — let's connect a model. Two or three questions.");
  out("");
  for (const p of SETUP_PICKS) out(`  ${p.key}  ${p.label}`);
  out("");
  let pick: Pick | undefined;
  for (let tries = 0; tries < 3 && pick === undefined; tries++) {
    const a = (await ask("Which one? [1-9, empty = cancel]: ")).trim();
    if (a.length === 0) { out(`cancelled — nothing changed. ${next("rovecode setup")} whenever you like`); return 2; }
    pick = SETUP_PICKS.find((p) => p.key === a || p.id === a);
    if (pick === undefined) out(`  "${a}" is not on the list — a number from 1 to 9, please.`);
  }
  if (pick === undefined) return 2;

  // ---- the provider: a built-in, a keyless local server, or a URL of your own ----
  let id: string;
  if (pick.url !== undefined) {
    id = (await ask("Short name for it (letters, digits, - _ .): ")).trim().toLowerCase();
    if (!PROVIDER_ID_RE.test(id)) { out(`  "${id}" won't work as an id. ${next("rovecode setup, and pick a name like myproxy")}`); return 2; }
    const baseUrl = (await ask("Base URL (e.g. https://host/v1): ")).trim();
    if (!/^https?:\/\//.test(baseUrl)) { out(`  "${baseUrl}" is not an http(s) URL. ${next("rovecode setup")}`); return 2; }
    const protocol = pick.url === "anthropic" ? "anthropic" : baseUrl.includes("anthropic.com") ? inferProtocol(baseUrl) : "openai";
    const noKey = (await ask("Does it need an API key? [Y/n]: ")).trim().toLowerCase().startsWith("n");
    const r = reg.add({ id, baseUrl, protocol, ...(noKey ? { noKey: true } : {}) }, "user");
    if ("error" in r) { out(`  ${r.error}. ${next("rovecode setup")}`); return 2; }
    out(`◆ ${id} registered (${protocol} protocol, ${baseUrl}).`);
  } else {
    id = pick.id!;
    const known = reg.get(id);
    if (known === undefined) { out(`  ${id} is missing from the built-in table — that is a bug. ${next("rovecode provider add " + id + " <baseUrl>")}`); return 2; }
    if (pick.local === true && known.noKey !== true) {
      // the built-in row expects a key env; a local server needs none — the user entry says so
      const r = reg.add({ id, baseUrl: known.baseUrl, protocol: known.protocol, noKey: true, ...(known.defaultModel !== undefined ? { defaultModel: known.defaultModel } : {}) }, "user");
      if ("error" in r) { out(`  ${r.error}. ${next("rovecode setup")}`); return 2; }
      out(`◆ ${id} marked as a local server (${known.baseUrl}, no key).`);
    }
  }

  // ---- the model ----
  const spec = reg.get(id)!;
  const suggested = spec.defaultModel;
  const modelAnswer = (await ask(suggested !== undefined ? `Model id [${suggested}]: ` : "Model id (empty = choose later with rovecode model list): ")).trim();
  const model = modelAnswer.length > 0 ? modelAnswer : suggested;

  // ---- the key ----
  let hasKey = isConfigured(spec);
  if (!hasKey) {
    const s = await secret(`${spec.keyEnv} (hidden): `);
    if (s.trim().length === 0) {
      out(`◆ no key stored — I can't call ${id} without one.`);
      out(`  ${next(`rovecode auth set ${id}`)}   (or set ${spec.keyEnv} in your environment)`);
    } else {
      save(id, s.trim(), spec.keyEnv);
      reg.refresh();
      hasKey = true;
      out(`◆ key stored for ${id} (hidden; ~/.rovecode/credentials.json).`);
    }
  } else out(`◆ ${id} already has a key (${spec.keySource === "stored" ? "stored" : `env ${spec.keyEnv}`}).`);

  // ---- one tiny real call ----
  if (hasKey && model !== undefined) {
    out(`◆ testing ${id}/${model} …`);
    const r = await probe(id, model);
    if (r.ok) out(`  ${r.detail}`);
    else {
      out(`  that didn't work: ${r.detail}`);
      out(`  ${next(`check the key and the URL, then rovecode provider test ${id} ${model}`)}`);
    }
  }

  // ---- make it the default ----
  if (model !== undefined) {
    const d = reg.setDefault(`${id}/${model}`, "user");
    if ("error" in d) { out(`  ${d.error}. ${next(`rovecode model use ${id}/<model>`)}`); return 2; }
    out(`◆ default → ${d.provider}/${d.model} (~/.rovecode/providers.json; running TUIs switch live).`);
  } else {
    out(`◆ ${id} is set up but has no model yet.`);
    out(`  ${next(`rovecode model list ${id}, then rovecode model use ${id}/<model>`)}`);
  }
  out("");
  out(SETUP_DONE);
  out("  or open the cockpit:  rovecode");
  return 0;
}
