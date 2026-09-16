<!-- Shipped copy (npm files[] can only reference files inside this package).
     Source of truth: THIRD_PARTY_NOTICES.md at the rovecode WORKSPACE root — the
     directory above this repo that holds BLUEPRINT.md/PORTS.md. Edit there,
     then re-copy here; nothing syncs it automatically. -->

# Third-party notices — rovecode

rovecode ports behavior from open-source agent harnesses. MIT-licensed sources (earendil-works/pi,
oh-my-pi, hermes-agent, senpi, opencode, prime-agent, models.dev/@opencode-ai/models,
@modelcontextprotocol/sdk) are credited in module headers and, where files are vendored
(vendor/pi-tui), ship with their upstream LICENSE and copyright headers intact. Apache-2.0
sources additionally get the entries below, per their license's NOTICE expectations.
No code originates from crush (FSL), claw-code, nanocoder, iflow, or the Claude Agent SDK.

## openai/codex (Apache-2.0)

Source: https://github.com/openai/codex, © 2025 OpenAI. Snapshot
`research/source_snapshots/openai-codex` @ 379d50be35d393631f45fde69197f3b9a592aa02.

- **execpolicy (port #9)** — `src/core/execpolicy.ts`, `src/core/execpolicy-rules.ts` contain
  code translated from codex: the prefix-rule model, decision ordering, strictest-wins
  evaluation, basename-fallback matching, load-time example validation, dangerous-command
  heuristics, and user-facing reason strings are direct TypeScript translations of
  `codex-rs/execpolicy/src/{decision,rule,policy,parser}.rs`, `codex-rs/core/src/exec_policy.rs`,
  and `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`. The word-only shell
  parser is a pattern-level reimplementation of `codex-rs/shell-command/src/bash.rs` (hand-rolled
  tokenizer enforcing the same accept/reject contract in place of a tree-sitter walk). The
  Starlark loader is replaced by TS object specs; network rules, host_executable allowlists,
  policy amendments, and the sandbox/approval-mode matrix are not ported.
- **executor ladder (port #10)** — `src/core/executor.ts` ports AT PATTERN LEVEL (no code
  copied) the sandbox-tier design: per-platform tier selection (SandboxType /
  get_platform_sandbox, `codex-rs/sandboxing/src/manager.rs`), trial-spawn availability probing
  (`bwrap.rs`), hard errors for unprovidable requested tiers (SandboxTransformError). Codex's
  silent downgrade (`unwrap_or(None)`) is intentionally NOT ported. The docker rung follows the
  OpenHands runtime-boundary pattern; OpenHands is not snapshotted — recorded as a provenance gap.
- **mid-turn cancellation (port #21)** — `src/core/loop.ts` and `src/core/tools.ts` follow AT
  PATTERN LEVEL (no code copied) codex's turn-abort and history-normalization semantics: one
  abortable active turn per session (`codex-rs/core/src/tasks/mod.rs:546-591`
  abort_turn_if_active) and synthesized outputs for tool calls left without a result so the next
  request is wire-well-formed (`codex-rs/core/src/context_manager/normalize.rs:51-67`, the
  "aborted" FunctionCallOutput). The per-run AbortSignal threading follows opencode (MIT,
  credited in the module header); the Windows Job-Object tree kill (`src/core/win-job.ts`) is
  rovecode's own.
- **sandbox rung config (port #27)** — `src/core/sandbox-config.ts` follows AT PATTERN LEVEL (no
  code copied) codex's sandbox-mode selection: the tier as a config choice layered file <
  override (`codex-rs/app-server/tests/common/config.rs:140` `sandbox_mode`;
  `codex-rs/utils/cli/src/shared_options.rs:40-41` `--sandbox`;
  `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs:14-25`), and an explicitly requested but
  unprovidable tier as a hard error (`codex-rs/sandboxing/src/manager.rs:203-222`
  SandboxTransformError). Here `.rovecode/sandbox.json` < `ROVECODE_SANDBOX`; rungs direct/wsl/docker only.
- **OpenAI Responses wire (aion port #75, 2026-09-07)** — `src/providers/responses.ts` follows AT PATTERN
  LEVEL (no code copied) the event set a Responses client consumes and the `event:` + `data:` pairing
  (`codex-rs/codex-api/src/sse/responses.rs:357-518`, fixtures :843-845), the ChatGPT Codex base URL
  (`codex-rs/model-provider-info/src/lib.rs:40`) and an `originator` header on every request
  (`codex-rs/core/src/client.rs:688`; the value here is `rovecode`). The request shape, the output-slot
  state machine and the `chatgpt-account-id` / `OpenAI-Beta` headers follow earendil-works/pi (MIT,
  credited in the module header). Not ported: codex's error taxonomy, websocket and zstd transports.
- **TUI notifications (aion port #79, 2026-09-07)** — `src/tui/notify-seq.ts` and `src/tui/notify.ts` follow AT
  PATTERN LEVEL (no code copied) codex's terminal-notification design: the `auto` backend chooser and its
  terminal list (`codex-rs/tui/src/notifications/mod.rs`), the tmux DCS passthrough with doubled ESC and its
  test vectors (`codex-rs/tui/src/notifications/osc9.rs`), the env markers per terminal
  (`codex-rs/terminal-detection/src/lib.rs`), the unfocused | always gate with focus starting true and the
  warn-once-then-disable write path (`codex-rs/tui/src/tui.rs`), the event set (`codex-rs/tui/src/chatwidget/
  notifications.rs`) and the `notify` argv hook with the payload as the last argument and nulled stdio
  (`codex-rs/hooks/src/legacy_notify.rs`). Deviations: focus reporting stays on under Windows, and the hook obeys
  the focus gate. OSC 777, the control-byte scrub, the argv parser and the trust gate are rovecode's own.

## cline (Apache-2.0)

Source: https://github.com/cline/cline. Snapshot `research/source_snapshots/cline-cline` @ 8eb5f3d.

- **shadow-git checkpoints (port #11)** — `src/coding/checkpoints.ts` ports cline's shadow-git
  checkpoint design (a second git repository with git-dir under `.rovecode/checkpoints/<session>`
  and the workspace as work-tree; the user's `.git` is never written): init/worktree/identity
  setup (`apps/vscode/src/integrations/checkpoints/CheckpointGitOperations.ts:88-94`), git-dir
  and worktree-mismatch reuse checks (`CheckpointUtils.ts:20-23`, `GitOperations.ts:70-73`),
  info/exclude handling (`CheckpointExclusions.ts:42-46,297-301`), snapshot-per-mutation
  (`CheckpointGitOperations.ts:213`). Ported from cline v3.89.2's last shadow-git
  implementation; cline v4's in-repo `git stash create` approach was deliberately not used
  (it rewrites the user's HEAD).
- **Plan/Act modes (port #20)** — `src/core/modes.ts` ports cline's Plan/Act mode design: mode
  semantics and defaults, per-mode provider/model configuration with the separate-models
  write-sync gate, plan-mode read-only tool restriction (mapped onto rovecode's deny-default
  permission rules), no-op same-mode toggles, and durable mode-switch notices. Mostly
  pattern-level; code/text-level translations: createModeSwitchNoticeTracker and
  formatModeSwitchNotice (near-verbatim from `sdk/packages/shared/src/prompt/format.ts:41-80`),
  the ACT_MODE_CONTINUATION_PROMPT string (`apps/vscode/src/sdk/sdk-user-message-mapping.ts:9`),
  and the plan-mode prompt section adapted from `sdk/packages/shared/src/prompt/cline.ts:34-59`.
- **image input (port #34)** — `src/core/images.ts` and `src/providers/wire-messages.ts` follow
  AT PATTERN LEVEL (no code copied) cline's image handling: the supported media-type set and
  5 MiB cap (`sdk/packages/shared/src/llms/media.ts:73-78, :80`), the request-time placeholder
  for models without vision while the stored history keeps the real image (`media.ts:6-12`;
  rovecode's wording is its own), the media-type mismatch rule, and the base64 source ↔
  `data:<mime>;base64,<data>` URL mapping (`apps/vscode/src/shared/messages/content.ts:140-153`).
  Sniffing, header dimensions and the sidecar store follow opencode (MIT, module header).
  Snapshot `cline-cline` @ 8eb5f3d.

## Aider (Apache-2.0)

Source: https://github.com/Aider-AI/aider. Snapshot `research/source_snapshots/Aider-AI-aider` @ 5dc9490.

- **repo-map (port #12)** — `src/coding/repomap.ts` ports aider's `aider/repomap.py` algorithm:
  Tag shape + mtime-keyed tags cache (L29, L233-264), def/ref classification (L318-336),
  def/ref graph with ident multipliers (L365-514), PageRank + rank→definition spread
  (L519-550), ranked file append (L560-574), binary-search token budgeting (L666-706), grouped
  tree rendering (L748-784). Symbol extraction uses @ast-grep/napi (tree-sitter) in place of
  aider's .scm tag queries.
- **reflection loop (port #28)** — `src/core/reflection.ts` + the rejection text in
  `src/coding/hashline.ts` follow aider's reflection pattern (no code copied):
  `aider/coders/base_coder.py` run_one reflection loop with `max_reflections` (L101,
  L924-944), per-message reset (L864-871), edit-apply / lint / test errors fed back as the
  next user message (L1596-1623, L2296-2328); the actionable failed-block report shape from
  `aider/coders/editblock_coder.py` L84-124 ("Did you mean to match some of these actual
  lines", the exact-match rule). Snapshot SHA 5dc9490.

## google-gemini/gemini-cli (Apache-2.0)

Source: https://github.com/google-gemini/gemini-cli. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43.

- **provider fallback chains (port #14, fallback half)** — `src/providers/router.ts` ports the
  fallback-trigger conditions and chain-advance semantics from `packages/core/src`
  (retryable-status classification incl. 429/5xx, immediate first attempt on the fallback model
  — `retry.ts:404,459`, availability/model-policy chain — `modelPolicy.ts:52-56`, mid-stream
  failure handling adapted from `core/geminiChat.ts:655-679`). The role table half of the
  router follows oh-my-pi (MIT), credited in the module header.

### Port #22 — glob/grep/ls tools
`src/coding/files.ts` contains code translated from gemini-cli: the glob
recency-then-alphabetical sort comparator is a direct TypeScript translation of
`packages/core/src/tools/glob.ts:47-70` (sortFileEntries), and the ls output contract —
directories-first alphabetical sort, `[DIR] name` / `name (N bytes)` rows, the
`(N ignored)` gitignore note, and the empty-directory / not-a-directory messages — is
translated from `packages/core/src/tools/ls.ts:191-271`. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. Tool limits,
truncation-marker strings, and the per-line cap follow opencode (MIT, credited in the
module header); the ripgrep dependency both upstreams share is replaced by a
pure-TypeScript matcher over a `git ls-files` enumeration.

### Port #23 — same-model retry with backoff
`src/providers/retry.ts` ports the retryWithBackoff loop shape and retry policy from
`packages/core/src/utils/retry.ts` (attempt/doubling loop :296-310, :494-501, :517-524; defaults
:20, :42-47; retryable set and the explicit no-retry-on-400 rule :193-199, :49-62, :174-189; abort
passthrough :337-340; server-suggested delay as a floor :472-476), the abortable delay from
`utils/delay.ts:22-48`, and the "suggested delay beyond the cap is terminal" rule from
`utils/googleQuotaErrors.ts:120, :286-289`. Deviations: full jitter (AWS-style) instead of
+-30%/+20% jitter, a per-invocation total-time budget, the Retry-After header (RFC 9110 s10.2.3)
as the delay source, and 499 not retried. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. Classification is shared with
the port #14 router (`classifyStreamError`).

### Port #24 — approval diff preview
`src/coding/diff.ts` follows AT PATTERN LEVEL (no code copied) the confirmation-diff shaping of
`packages/core/src/tools/diffOptions.ts:10-18` (structuredPatch, small context) and the
CR-tolerant line comparison of `diff-utils.ts:22`. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43.

### Port #31 — web_fetch tool
`src/tools/webfetch.ts` contains code adapted from gemini-cli: the bounded streaming body
reader is a TypeScript adaptation of `readResponseWithLimit`
(`packages/core/src/tools/web-fetch.ts:555-587`, changed to truncate with a marker instead of
throwing); the timer-driven AbortController chained to the caller's signal follows
`fetchWithTimeout` (`packages/core/src/utils/fetch.ts:190-230`); the private-host refusal
semantics — localhost/loopback names, resolve-then-check over all addresses, IPv4-mapped
unmapping, the 198.18.0.0/15 benchmark range — follow `isBlockedHost`/`isAddressPrivate`/
`isPrivateIpAsync` (`web-fetch.ts:270-281`, `fetch.ts:94-169`) reimplemented without ipaddr.js.
Snapshot `research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. Tool contract, scheme
gate, default timeout and html/passthrough split follow opencode (MIT, credited in the module
header); html-to-text/htmlparser2/turndown are replaced by `src/tools/html-text.ts`.

### Port #32 — todo/plan tool
`src/tools/todo.ts` ports the todo-list validation contract from gemini-cli
`packages/core/src/tools/write-todos.ts:100-129` (validateToolParamValues: array check, per-item
object / non-empty description / status-enum checks, and the "only one task can be in_progress at
a time" rule :120-126), translated into rovecode's ok/error result shape with ids and size bounds
added; the "Cleared todo list" wording (:52, :68) is gemini's. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. Tool contract (whole-list replace,
content/status/priority) and when-to-use guidance follow opencode (MIT, module header).

### Port #30 — custom slash commands
`src/tui/commands.ts` follows AT PATTERN LEVEL (no code copied) gemini-cli's file-command loader:
user directory first, project directory second with "last wins" conflict resolution
(`packages/cli/src/services/FileCommandLoader.ts:85-90`, `:204-228`), a single scan when the
project dir is the user's home (`:221-228`), and invalid command files skipped with a report,
never fatal (`:277-298`). Snapshot `research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43.
Discovery, frontmatter/template split, precedence and `$ARGUMENTS`/`$N` templating follow
opencode (MIT, credited in the module header).

### Port #33 — ask_user tool
`src/tools/ask-user.ts` follows AT PATTERN LEVEL (no code copied) gemini-cli's headless rule for
user-facing questions: with no human present the ask-user tool is excluded and ASK_USER decisions
translate to DENY (`packages/cli/src/config/config.ts:794-803`); rovecode keeps the tool registered on
every surface and fails closed at execute time instead. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. The tool contract (option labels,
typed answer, dismissed question = error) follows opencode (MIT, credited in the module header).

### Port #81 — workspace roots (`--add-dir`)
`src/core/workspace.ts` follows AT PATTERN LEVEL (no code copied) opencode's external-directory
handling (`external-directory.ts` and `fs-util.ts` `contains()`: an added directory is a peer of the
cwd, and containment is decided on canonical paths, not on string prefixes) and gemini-cli's
`isPathWithinRoot`. Snapshots `research/source_snapshots/opencode-2026` @ ebece6e and
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43. What is not followed: neither project
puts the boundary in the permission ladder as its own action — rovecode evaluates `file.external` at
dispatch so the refusal is a card a person can answer, and so an "always" is remembered per directory.

### Port #57/#76 — MCP prompts, resources, status and OAuth
`src/mcp/prompts-resources.ts` follows AT PATTERN LEVEL (no code copied) gemini-cli's
`list-mcp-resources.ts` / `read-mcp-resource.ts`: server-scoped listing, text content returned
verbatim, binary content summarized rather than inlined. `src/mcp/status.ts` follows its `/mcp`
per-server status rows (state, tool and prompt counts, the remedy line). `src/mcp/oauth.ts` follows
`packages/core/src/mcp/oauth-provider.ts:399-405` — start the loopback callback server FIRST so the
redirect URI names a port that is already listening, rather than racing the browser. Snapshot
`research/source_snapshots/google-gemini-gemini-cli` @ 0bd1d43.

The provider-class shape over the SDK's own seam was additionally read from opencode's
`packages/opencode/src/mcp/oauth-provider.ts` (MIT); its FIXED callback port is deliberately not
followed — rovecode allocates an ephemeral one, so two logins cannot collide and a stuck listener
cannot block the next attempt.

MCP OAuth itself is done through `@modelcontextprotocol/sdk`'s `OAuthClientProvider` seam (MIT —
dependency, API usage, not a port): the SDK performs discovery, dynamic client registration, PKCE and
refresh; rovecode supplies persistence (`~/.rovecode/credentials.json`, 0600), the loopback redirect
and the `rovecode mcp login` command.

## Zed Industries — agent-client-protocol (Apache-2.0)

- **ACP endpoint (port #15)** — `src/acp/server.ts` speaks ACP v1 via the official SDK
  dependency `@zed-industries/agent-client-protocol@0.4.5` (Apache-2.0, © Zed Industries).
  The SDK is consumed as a package dependency; no SDK code is vendored or modified.

## jsdiff — `diff` npm package (BSD-3-Clause)

Source: https://github.com/kpdecker/jsdiff. Consumed unmodified as the package dependency
`diff@9.0.0` by `src/coding/diff.ts` (port #24, approval-overlay diff preview). The compiled
single binary (scripts/build.ts) bundles it; per BSD-3-Clause clause 2 the notice below is
reproduced verbatim for binary redistribution.

```
BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
