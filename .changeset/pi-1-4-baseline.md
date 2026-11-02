---
"@inv1x/pi-subagents": minor
---

Raise the minimum supported Pi version to 1.4.0 and pin all four development SDK packages and the lockfile to that release. Older Pi hosts are no longer supported. Fresh local installations no longer restore the 0.87.1 child SDK, which predates OpenAI ChatGPT login support. Include the newer host's completion-run, overlay, resumed-tool, and summary reliability fixes; migrate tool-context test fixtures and verify the dependency tree in CI. Document the baseline rationale, migration checks, and optional future API adoption separately from this compatibility update.
