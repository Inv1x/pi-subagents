# Changelog

## Unreleased

### Changed

- Updated Pi development dependencies to 0.84.1, aligned TypeBox to 1.3.7, and require Node.js 22.19 or newer.
- Child routing now honors Pi session model scopes, including workflow replay snapshots and model-profile settings.
- Project workflow discovery is inert; trusted project TypeScript is imported only after an interactive launch confirmation.
- Named agent skills are resolved by the parent and loaded into children by exact path.
- Workflow definitions and agent steps can validate declared TypeBox input/output schemas.

### Fixed

- Parse Pi 0.84 delta-only JSON updates with bounded live assembly while treating `message_end` as authoritative.
- Fail zero-exit children that lack a final assistant result or `agent_settled` lifecycle watermark.
- Prefer strict constrained sampling only for closed, compatible management/delegation tool schemas.
- Clarified workflow failure collection and background-process durability semantics.
