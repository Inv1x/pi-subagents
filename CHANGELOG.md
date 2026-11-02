# Changelog

## 0.8.0

### Minor Changes

- 55542a8: Raise the minimum supported Pi version to 1.4.0 and pin all four development SDK packages and the lockfile to that release. Older Pi hosts are no longer supported. Fresh local installations no longer restore the 0.87.1 child SDK, which predates OpenAI ChatGPT login support. Include the newer host's completion-run, overlay, resumed-tool, and summary reliability fixes; migrate tool-context test fixtures and verify the dependency tree in CI. Document the baseline rationale, migration checks, and optional future API adoption separately from this compatibility update.

### Patch Changes

- edd5983: Preserve SDK child startup failures instead of masking them with IPC `write EPIPE` errors. Report the Node.js executable and suggest restarting Pi when a missing executable may be caused by a Node upgrade. Only send the invocation after the child spawns successfully.

## 0.7.0

### Minor Changes

- Require Pi 0.87.1 and use canonical projected parent context and transcript-backed agent prompt sections. Classify PowerShell as mutating for writer leases and retry safety.

  Add an isolated SDK child host with private canonical session checkpoints, stateful `subagent_control send`, per-invocation scheduler leases, worktree patch restoration, clean turn limits, bounded tool-free handoffs, compaction diagnostics, and complete child usage accounting. Preserve the explicit legacy CLI override, without stateful sends.

  Add opt-in authenticated context summarization with accounted usage and append-only shortening of consumed completion notifications. Cover the migration with real session/projection tests and offline SDK subprocess integration tests.

### Patch Changes

- 4dd12dc: Keep child responses out of the main transcript, fix fleet navigation and retention, use all available models for routing, and harden child lifecycle, protocol validation, environment isolation, and run snapshots.
- cd95e55: Adopt Changesets for version and changelog management.

## Unreleased

### Changed

- Updated Pi development dependencies to 0.84.1, aligned TypeBox to 1.3.7, and require Node.js 22.19 or newer.
- Keep subagent, workflow, and control transcript rows quiet: child response bodies and Ctrl+O details are no longer rendered or streamed, while full model-visible results and artifacts remain available. Background completion messages are hidden with `display: false`.
- Resolve child, profile, workflow, and doctor models against every available registry model, ignoring current and old persisted `scopedModels` restrictions.
- `/subagents-fleet` now uses Kitty-aware literal shortcuts, reserves `j`/`k` for selected-detail scrolling, omits difficulty, and retains tasks, final results/errors, and output/transcript/patch paths.
- Completed runs and workflow families remain inspectable for five minutes based on `endedAt`; later status updates do not extend visibility.
- Project workflow discovery is inert; trusted project TypeScript is imported only after an interactive launch confirmation.
- Named agent skills are resolved by the parent and loaded into children by exact path.
- Workflow definitions and agent steps can validate declared TypeBox input/output schemas.

### Fixed

- Made every field in strict-sampled tool objects required, using nullable values for optional semantics, so Codex/OpenAI accepts the schemas.
- Ignore Pi 0.84 assistant deltas and runtime-validate authoritative `message_end` assistant content and usage without crashing line callbacks.
- Fail zero-exit children that lack a final assistant result or `agent_settled` lifecycle watermark.
- Strip parent session/model environment variables from child processes.
- Escalate POSIX process-group termination even after the leader exits, and await active agent/workflow shutdown on full quit.
- Return centralized deep run snapshots so callers and listeners cannot mutate runtime-owned nested state.
- Removed stale `needs_input` state checks.
- Prefer strict constrained sampling only for closed, compatible management/delegation tool schemas.
- Clarified workflow failure collection and background-process durability semantics.
