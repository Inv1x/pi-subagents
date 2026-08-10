# Changelog

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
