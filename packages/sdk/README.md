# @rovecode-labs/sdk

Embed the [rovecode](https://github.com/9Code-Labs/rovecode-community) coding-agent harness in your
own Bun/TypeScript process — sessions, streamed prompts, background subagent tasks, and the live
agent tree. **One client = one engine**: the SDK boots the same runtime the CLI boots (no second
loop), so everything the CLI can do, your process can do.

```bash
bun add @rovecode-labs/sdk
```

```ts
import { createClient, mockStream } from "@rovecode-labs/sdk";

const rc = await createClient({ cwd: process.cwd() }); // resolves your configured provider
const session = await rc.session.create();

for await (const ev of session.prompt("fix the failing test in src/auth.ts")) {
  if (ev.type === "agent_tree_update") renderTree(ev.tree);   // live subagent tree
  if (ev.type === "run_end") console.log(ev.status);
}

await rc.close();
```

## Surface

- `createClient({ cwd?, stream?, yolo?, approval? })` → `Promise<RovecodeClient>`
- `rc.session.create({ id? })` / `rc.session.list()`
- `session.prompt(goal, { signal? })` → async generator of `SdkEvent` (every `RunEvent` of the run
  plus `agent_tree_update` frames synthesized from the task registry)
- `rc.task.start(sessionId, { agent?, goal, label?, isolated? })` · `list` · `wait` · `cancel`
- `rc.agent.tree(sessionId)` — the current parent→children task tree
- `rc.events.subscribe(fn)` — client-level tap of everything
- `mockStream({ turns })` — scripted provider for tests: no keys, no network

## Testing

```ts
import { createClient, mockStream, textTurn } from "@rovecode-labs/sdk";

const rc = await createClient({ cwd: tmp, stream: mockStream({ turns: [textTurn("done")] }) });
```

## Notes

- Requires **Bun ≥ 1.3.14** (the harness is Bun-native).
- Runs fully local: provider keys come from your normal rovecode config (`rovecode connect`).
- For a hosted/headless setup, run `rovecode serve` (the same repo) and drive it over HTTP —
  a first-party `remote` transport on these exact types is on the roadmap.
- 0.x surface: expect evolution, pinned by contract tests upstream.

AGPL-3.0-only · 9Code Labs
