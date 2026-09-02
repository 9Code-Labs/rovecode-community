<!-- Shipped copy (npm files[] can only reference files inside this package).
     Source of truth: THIRD_PARTY_NOTICES.md at the aion WORKSPACE root — the
     directory above this repo that holds BLUEPRINT.md/PORTS.md. Edit there,
     then re-copy here; nothing syncs it automatically. -->

# Third-party notices — aion

aion ports behavior from open-source agent harnesses. MIT-licensed sources (earendil-works/pi,
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

## cline (Apache-2.0)

Source: https://github.com/cline/cline. Snapshot `research/source_snapshots/cline-cline` @ 8eb5f3d.

- **shadow-git checkpoints (port #11)** — `src/coding/checkpoints.ts` ports cline's shadow-git
  checkpoint design (a second git repository with git-dir under `.aion/checkpoints/<session>`
  and the workspace as work-tree; the user's `.git` is never written): init/worktree/identity
  setup (`apps/vscode/src/integrations/checkpoints/CheckpointGitOperations.ts:88-94`), git-dir
  and worktree-mismatch reuse checks (`CheckpointUtils.ts:20-23`, `GitOperations.ts:70-73`),
  info/exclude handling (`CheckpointExclusions.ts:42-46,297-301`), snapshot-per-mutation
  (`CheckpointGitOperations.ts:213`). Ported from cline v3.89.2's last shadow-git
  implementation; cline v4's in-repo `git stash create` approach was deliberately not used
  (it rewrites the user's HEAD).
- **Plan/Act modes (port #20)** — `src/core/modes.ts` ports cline's Plan/Act mode design: mode
  semantics and defaults, per-mode provider/model configuration with the separate-models
  write-sync gate, plan-mode read-only tool restriction (mapped onto aion's deny-default
  permission rules), no-op same-mode toggles, and durable mode-switch notices. Mostly
  pattern-level; code/text-level translations: createModeSwitchNoticeTracker and
  formatModeSwitchNotice (near-verbatim from `sdk/packages/shared/src/prompt/format.ts:41-80`),
  the ACT_MODE_CONTINUATION_PROMPT string (`apps/vscode/src/sdk/sdk-user-message-mapping.ts:9`),
  and the plan-mode prompt section adapted from `sdk/packages/shared/src/prompt/cline.ts:34-59`.

## Aider (Apache-2.0)

Source: https://github.com/Aider-AI/aider. Snapshot `research/source_snapshots/Aider-AI-aider`.

- **repo-map (port #12)** — `src/coding/repomap.ts` ports aider's `aider/repomap.py` algorithm:
  Tag shape + mtime-keyed tags cache (L29, L233-264), def/ref classification (L318-336),
  def/ref graph with ident multipliers (L365-514), PageRank + rank→definition spread
  (L519-550), ranked file append (L560-574), binary-search token budgeting (L666-706), grouped
  tree rendering (L748-784). Symbol extraction uses @ast-grep/napi (tree-sitter) in place of
  aider's .scm tag queries.

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

## Zed Industries — agent-client-protocol (Apache-2.0)

- **ACP endpoint (port #15)** — `src/acp/server.ts` speaks ACP v1 via the official SDK
  dependency `@zed-industries/agent-client-protocol@0.4.5` (Apache-2.0, © Zed Industries).
  The SDK is consumed as a package dependency; no SDK code is vendored or modified.
