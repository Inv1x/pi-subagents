# Pi Subagents — Product and Architecture Plan

Status: implemented; current release 0.5.0  
Target: `@earendil-works/pi-coding-agent` 0.81.x  
Research date: 2026-07-20

## 1. Goal

Build a Pi package that provides a Claude Code-like delegation experience without turning the parent conversation into an unbounded orchestration log.

The package should support two complementary paths:

1. **Interactive delegation** — run one child agent, or let Pi issue several child-agent tool calls in one turn so Pi's native parallel tool execution runs them concurrently.
2. **Programmatic workflows** — run durable TypeScript workflows that can dynamically fan out to many bounded child agents, join results, branch, loop, pause for approval, and resume safely.

The default experience should remain simple:

```text
Ask the reviewer to inspect this diff.
Run three scouts in parallel over the API, tests, and database layers.
Run the implement-and-review workflow for this request.
```

## 2. Research summary

### Claude Code patterns worth matching

Claude Code's current design separates several concepts:

- Custom agents are Markdown files with YAML frontmatter (`name`, `description`, tools, model) and a specialist prompt body.
- A subagent has an isolated context and may run in the foreground or background.
- Multiple `Agent` tool calls can be emitted together for concurrent work.
- Worktree isolation is available for agents that edit concurrently.
- Agent teams add a lead, shared tasks, teammate communication, and explicit user approval before the team is created.
- Programmatic/headless use exposes streaming events, structured results, session continuation, permission callbacks, and turn limits.
- The agent-view UI groups work by states such as working, ready for review, needs input, and completed.

Source used: official Claude Code documentation through Context7 library `/websites/code_claude` (subagents, agent teams, worktrees, Agent SDK, agent view).

### Pi capabilities we should use

Pi 0.81.x already gives us the needed extension primitives:

- `pi.registerTool()` with streaming `onUpdate` and custom `renderCall`/`renderResult`.
- Native concurrent execution of sibling tool calls.
- `ctx.ui.setStatus()`, `setWidget()`, notifications, custom overlays, and theme-aware TUI components.
- `pi.appendEntry()` for persistent extension metadata that stays out of model context.
- Session and lifecycle events, cancellation signals, and graceful shutdown hooks.
- JSON event-stream mode for isolated child processes.
- Public SDK sessions for a future lower-overhead transport.
- Pi package manifests for distributing extensions, agents, prompts, and workflows.

Primary local references:

- `docs/extensions.md`
- `docs/tui.md`
- `docs/sdk.md`
- `docs/json.md`
- `docs/security.md`
- `examples/extensions/subagent/`

### Similar packages reviewed

| Package | Useful ideas | Caution for this project |
|---|---|---|
| Pi's bundled `subagent` example | Isolated Pi subprocesses, single/parallel/chain modes, streaming, usage rendering | No background lifecycle, durable scheduler, dynamic workflow replay, or safe concurrent-write strategy |
| `pi-subagents` | Rich child protocol, async artifacts, context modes, spawn budgets, worktrees, fleet UI, supervisor channel | Roughly 100k TypeScript LOC; avoid copying its feature breadth into the first release |
| `@narumitw/pi-subagents` | Clean split between blocking batch work and addressable stateful agents; optional SDK transport; write-conflict guard | Stateful transport and persistence add significant lifecycle complexity |
| `pi-crew` | Durable runs, task graphs, worktrees, approval gates, observability, dynamic workflows | Very large surface and a “god tool”; avoid 40+ actions and premature platform features |
| `pi-ate-workflow` | Small workflow/subprocess/state separation | Sequential, file-oriented, and no live streaming |
| `smithers-orchestrator` | Explicit step IDs, validated outputs, durable replay/memoization, parallel/branch/loop primitives | A separate general orchestration platform and dependency would be excessive for the core extension |

Decision: implement a focused native Pi package. Borrow the durable-step model conceptually, but do not depend on a general workflow framework in v1.

## 3. Product principles

1. **Simple requests stay simple.** A single delegation is one narrow tool call.
2. **Use Pi's native sibling-tool parallelism.** The model can call the single-agent tool several times in one assistant message; all calls still pass through one global scheduler.
3. **Concurrency must be bounded globally.** A workflow cannot evade limits by nesting or issuing several tool calls.
4. **Read concurrency is easy; write concurrency is not.** Concurrent writers require isolated worktrees or are rejected.
5. **Background work is observable, not noisy.** Show compact state and notify only on meaningful transitions.
6. **Model context receives summaries; artifacts retain detail.** Never inject full fleets of transcripts into the parent.
7. **Programmatic workflows are explicit and replayable.** Every side-effecting workflow step has a stable ID.
8. **Project code is executable configuration.** Project-local agents are prompts; project-local TypeScript workflows are arbitrary code. Both require trust, and workflow code gets an additional launch preview.
9. **No implied sandbox.** Child processes run as the same OS user unless the user configures an external sandbox.
10. **Headless and TUI modes share one state model.** UI is a projection over versioned events and artifacts.

## 4. User-facing surface

### 4.1 Agent definitions

Discovery precedence:

1. Package built-ins
2. Installed-package agent directories
3. `~/.pi/agent/agents/**/*.md`
4. Trusted project config directory, normally `.pi/agents/**/*.md`

Project definitions override lower-priority names. Names are validated and duplicate sources are shown by `/subagents-doctor`.

Proposed frontmatter:

```markdown
---
name: reviewer
description: Reviews code for correctness, security, tests, and unnecessary complexity.
tools: read, grep, find, ls, bash
model: inherit
thinking: medium
context: fresh
workspace: shared
maxTurns: 12
timeoutMs: 600000
---

You are a senior code reviewer. Do not edit files. Return findings with file and line evidence.
```

Initial fields:

- `name`, `description`
- `tools`
- `model`, `thinking`
- `context: fresh | summary | fork`
- `workspace: shared | worktree`
- `maxTurns`, `timeoutMs`
- `skills`
- `systemPromptMode: replace | append`
- `inheritProjectContext`

Defer memory, model fallback chains, child-only extensions, nested delegation, and per-agent mailbox policy until later.

### 4.2 Narrow tools

Avoid a single tool with dozens of management actions.

#### `subagent_run`

Runs exactly one child job. Pi can call it several times in one assistant message for parallel work.

```ts
{
  agent: string;
  task: string;
  background?: boolean;
  context?: "fresh" | "summary" | "fork";
  model?: string;
  thinking?: ThinkingLevel;
  cwd?: string;
  workspace?: "shared" | "worktree";
  timeoutMs?: number;
  maxTurns?: number;
}
```

Prompt guidance will explicitly say:

- Use no child for trivial or latency-sensitive work.
- For independent parallel work, emit multiple `subagent_run` calls in the same turn.
- Prefer two to four read-only children; larger fan-out belongs in a workflow.
- Do not run concurrent shared-workspace writers.
- Use background mode only if the parent can continue useful independent work.

#### `subagent_control`

Small management schema:

```ts
{
  action: "list" | "status" | "wait" | "send" | "interrupt" | "stop";
  runId?: string;
  message?: string;
  timeoutMs?: number;
}
```

`send` is deferred until the persistent RPC/SDK transport exists. Until then, completed runs can be followed up by starting a new child with selected context.

#### `workflow_run`

```ts
{
  workflow: string;
  input: unknown;
  background?: boolean;
  preview?: boolean;
}
```

#### `workflow_control`

```ts
{
  action: "list" | "status" | "wait" | "approve" | "reject" | "stop" | "resume";
  runId?: string;
  gateId?: string;
  message?: string;
  timeoutMs?: number;
}
```

### 4.3 Commands

- `/subagents` — list available agents and effective model/tool settings.
- `/subagents-fleet` — live two-pane fleet inspector.
- `/subagents-stop [runId]` — selector when ID is omitted.
- `/workflows` — list workflows and descriptions.
- `/workflow-run <name>` — preview input and launch.
- `/workflow-status [runId]` — open workflow graph/step inspector.
- `/subagents-doctor` — trust, executable, model, agent, workflow, and stale-run diagnostics.

No default global shortcut in v1. A shortcut can be made configurable after conflicts and user demand are understood.

## 5. Programmatic workflow API

### 5.1 Discovery and trust

Proposed locations:

- Package: `workflows/**/*.workflow.ts`
- User: `~/.pi/agent/workflows/**/*.workflow.ts`
- Project: `.pi/workflows/**/*.workflow.ts`

Project TypeScript workflows load only when `ctx.isProjectTrusted()` is true. The first launch displays source path, requested agents, write capability, worktree use, and estimated fan-out before execution.

### 5.2 API shape

```ts
import { defineWorkflow } from "pi-subagents/workflow";

export default defineWorkflow({
  name: "implement-and-review",
  description: "Plan, implement, review in parallel, then fix accepted findings.",
  input: Type.Object({ request: Type.String() }),

  async run(ctx, input) {
    const context = await ctx.agent("scout", {
      agent: "scout",
      task: `Map the code relevant to: ${input.request}`,
    });

    const plan = await ctx.agent("plan", {
      agent: "planner",
      task: `Create a concrete plan.\n\nContext:\n${context.output}`,
      dependsOn: ["scout"],
    });

    await ctx.gate("approve-plan", {
      title: "Approve implementation plan",
      summary: plan.output,
    });

    const implementation = await ctx.agent("implement", {
      agent: "worker",
      task: plan.output,
      workspace: "shared",
    });

    const reviews = await ctx.map(
      "reviews",
      ["correctness", "tests", "simplicity"],
      (focus) => ({
        agent: "reviewer",
        task: `Review the implementation for ${focus}. Do not edit files.`,
      }),
      { concurrency: 3 },
    );

    return ctx.agent("fix-review-findings", {
      agent: "worker",
      task: ctx.template`Apply only valid findings.\n${reviews.map(r => r.output)}`,
    });
  },
});
```

### 5.3 Required primitives

- `ctx.agent(stepId, spec)` — one memoized child step.
- `ctx.parallel(groupId, specs, options)` — bounded static fan-out.
- `ctx.map(groupId, items, factory, options)` — bounded dynamic fan-out with a hard item cap.
- `ctx.gate(gateId, options)` — pause for user approval or input.
- `ctx.output(stepId)` — retrieve validated prior output.
- `ctx.log(message, data?)` — append a workflow event without polluting model context.
- `ctx.setResult(value)` — optional explicit workflow result.
- `ctx.signal` — cancellation signal.

Normal TypeScript `if`, `for`, `while`, `Promise.all`, and helper functions provide branching and composition. The scheduler remains authoritative even if workflow code uses `Promise.all` directly.

### 5.4 Replay contract

Arbitrary JavaScript call stacks cannot be serialized safely. Durability therefore uses deterministic replay:

1. A workflow run restarts from the top after a process crash.
2. `ctx.agent("stable-id", ...)`, `ctx.map("stable-id", ...)`, and `ctx.gate("stable-id", ...)` check the run store.
3. Completed steps return their persisted result without re-running.
4. Running steps whose owner died become `orphaned` and follow configured retry policy.
5. Reusing an ID with a changed normalized specification fails with a workflow-drift error unless the user explicitly forks/restarts the run.

Workflow authors must use stable IDs and keep code deterministic between durable steps. This is simpler and safer than attempting to snapshot closures.

### 5.5 Structured output

Each child may declare a TypeBox/JSON Schema output. The worker prompt requests the schema, and the runtime validates before a step succeeds. Invalid output may receive one bounded repair attempt. Raw text remains available as an artifact.

## 6. Runtime architecture

```text
Pi extension
├── Tool/command façade
├── Agent + workflow discovery
├── Global scheduler
├── Foreground/background run controller
├── Event reducer + UI projections
└── Run-store watcher

Orchestrator runner process (for workflows/background runs)
├── Workflow loader
├── Deterministic step runtime
├── Global/per-run concurrency leases
├── Child transport
├── Gate handling
└── Durable run store

Child Pi process
├── Isolated context window
├── Explicit system prompt/model/tool allowlist
├── JSON event stream
└── Bounded result/transcript
```

### 6.1 Transport abstraction

Define a transport interface from the start:

```ts
interface AgentTransport {
  start(spec: ResolvedAgentSpec, sink: EventSink): Promise<AgentHandle>;
  abort(runId: string): Promise<void>;
}
```

Initial transport: isolated Pi CLI process using JSON event-stream mode.

- Launch with `--mode json`, `-p`, and `--no-session` for one-shot work.
- Disable extension discovery by default to prevent recursion and unexpected side effects.
- Pass only explicitly selected tools and child resources.
- Parse complete `message_end`, tool lifecycle, retry, and settled events.
- Keep the interface compatible with a future subprocess worker built on Pi's public SDK or RPC mode for stateful follow-ups.

Do not begin with in-process children. Process isolation is more valuable than cold-start savings for the first reliable release.

### 6.2 Global scheduler

One scheduler instance coordinates every foreground tool call, background run, and workflow.

Limits:

- Global active children: default 4.
- Per-workflow active children: default 4.
- Maximum static/dynamic fan-out: default 16, hard default 64.
- Maximum workflow nodes: default 100.
- Nesting depth: 0 in v1; workflows own fan-out.
- Per-run token/cost/turn/time budgets where usage data is available.

Queue behavior:

- FIFO within priority class.
- Interactive foreground work before detached background work, without starving background queues.
- Abort queued jobs immediately when their parent is cancelled.
- Acquire write/workspace leases before process spawn.
- Expose queued position and reason in status.

### 6.3 State machine

Run/node states:

```text
queued → starting → running ─┬→ succeeded
                            ├→ needs_input → running
                            ├→ paused → running
                            ├→ failed
                            ├→ timed_out
                            ├→ cancelled
                            └→ orphaned → queued | failed
```

Terminal states are immutable. Every transition includes timestamp, reason, parent run ID, workflow step ID, and optional usage snapshot.

### 6.4 Durable artifacts

Default root should be user-scoped rather than committed into the project:

```text
~/.pi/agent/subagents/runs/<run-id>/
├── manifest.json
├── status.json
├── events.jsonl
├── workflow.json
├── nodes/<step-id>/status.json
├── nodes/<step-id>/result.json
├── nodes/<step-id>/transcript.jsonl
├── nodes/<step-id>/stderr.log
└── patches/<step-id>.patch
```

Requirements:

- Version every persisted schema.
- Append events and atomically replace snapshots.
- Use private directory/file modes where supported.
- Bound transcript, stderr, line size, and model-visible result sizes.
- Preserve full oversized output in an artifact and return a path plus truncation marker.
- Ignore unknown future event fields when reading.
- Add retention settings and explicit cleanup; never silently delete an active run.

### 6.5 Child protocol hardening

The bundled sample's simple `buffer.split("\n")` parser is not enough for large fleets.

Implement:

- Incremental UTF-8-safe line framing.
- Maximum JSONL line size.
- Bounded stderr tail.
- Valid final unterminated line handling.
- Malformed-event diagnostics without unbounded logging.
- Terminal watermark based on the settled lifecycle, not merely the first `agent_end` during retry/compaction.
- Process-tree termination: TERM, grace period, then KILL; Windows-specific tree termination.
- Removal of abort listeners/timers after exit.
- Distinguish spawn failure, protocol failure, model failure, timeout, cancellation, and nonzero exit.

### 6.6 Context policies

- `fresh` — specialist prompt plus optionally trusted project instructions.
- `summary` — a bounded parent summary and selected recent user/assistant text.
- `fork` — a real branched Pi session when the relevant public API is suitable; otherwise defer rather than faking full inheritance.

Never forward hidden reasoning, credentials, raw tool results, previous subagent orchestration messages, or unrelated large transcripts. Record what context policy was used in result metadata.

## 7. Concurrent write safety

Tool allowlists are capability hints, not a security sandbox. Any agent with `bash`, `write`, or `edit` is conservatively classified as write-capable.

Rules:

1. Multiple read-only agents may share a workspace.
2. Only one write-capable agent may use a shared workspace at a time.
3. Parallel writers require `workspace: "worktree"`.
4. Worktree mode requires a Git repository and a clean base state in v1.
5. Each writer receives a disposable branch/worktree.
6. On completion, capture a patch and diff summary before cleanup.
7. Do not auto-merge parallel patches in v1. A later explicit apply/reconciliation step handles them serially.
8. Setup hooks are executable code and require explicit trusted user configuration.

Future: path-level leases, automatic conflict detection, and a dedicated reconciliation agent. Do not promise safe automatic merging in the initial release.

## 8. UI plan

### 8.1 In-conversation tool row

Collapsed while running:

```text
● reviewer  reviewing auth changes · read src/auth.ts · 42s
  3 turns · 18 tools · 24k tokens · $0.08
```

Terminal:

```text
✓ reviewer  4 findings · 1m12s · 31k tokens · $0.11
```

Behavior:

- Reuse `context.lastComponent` for efficient streaming updates.
- Show the last few meaningful activities, not every token delta.
- Expanded view (`app.tools.expand`, normally Ctrl+O) shows task, tool timeline, final Markdown, usage, model, workspace, artifact paths, and failure details.
- Use text glyphs plus labels; color is not the only state signal.

When Pi emits several sibling `subagent_run` calls, each gets its own native tool row and all share the fleet status projection.

### 8.2 Compact projection

The shipped 0.5.0 UI intentionally avoids an above-editor widget. Active and recently finished work is projected into one footer status so child activity does not move the editor or crowd the transcript.

### 8.3 Footer status

```text
2 agents running · 1 workflow needs input · $0.41 · /subagents-fleet
```

Keep it compact, session-scoped, and remove it when no run is relevant to the current session. The status does not intercept arrows or Enter; `/subagents-fleet` opens the fleet inspector without conflicting with selectors and other overlays.

### 8.4 Fleet overlay

`/subagents-fleet` opens a responsive two-pane overlay:

- Left: grouped runs and children with state, agent, elapsed time.
- Right: selected child task, current tool, transcript tail, usage, model, workspace, output/patch/session paths.
- Filters: current session, running, needs input, recent, all.
- Keys: arrows select runs, `g/G` jump first/last, `j/k` scroll output, `b` backgrounds an eligible standalone agent, `r` refreshes, and Esc closes.
- Other mutations stay in explicit commands.
- Narrow terminals fall back to one pane or textual status.

### 8.5 Workflow graph overlay

`/workflow-status` uses the same component shell but groups by workflow step:

```text
✓ scout
✓ plan
■ approve-plan       needs approval
◦ implement
├─ ◦ review:correctness
├─ ◦ review:tests
└─ ◦ review:simplicity
◦ fix-review-findings
```

The detail pane shows inputs, dependencies, attempts, validation, and artifacts.

### 8.6 Notifications

Notify only on:

- Background run completed.
- Run failed/timed out.
- Approval or user input required.
- Run appears orphaned/stalled.

Do not notify for every child tool call. In non-TUI modes, emit structured events/artifacts and avoid UI APIs.

## 9. Security and trust

- Explain prominently that subagents are not sandboxes.
- Default project-agent scope to user-only unless the user opts into project agents.
- Require `ctx.isProjectTrusted()` before reading project-local agent/workflow configuration.
- Confirm project-local agent prompts the first time they are invoked interactively.
- Show an additional launch preview for project-local TypeScript workflows because they execute arbitrary code.
- Child tool allowlists should be strict; unknown tools are rejected rather than silently ignored.
- Background runs must not wait on an invisible interactive permission prompt. Unsupported “ask” policies fail with a clear `needs_input` result or require a supervisor bridge in a later milestone.
- Redact obvious credentials from diagnostic/event previews, but do not claim redaction is a security boundary.
- Support external container/sandbox transport later instead of inventing a partial in-process sandbox.

## 10. Failure and result contract

Every child result should include:

```ts
interface ChildResult {
  runId: string;
  stepId?: string;
  agent: string;
  state: "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned";
  output: string;
  outputArtifact?: string;
  transcriptArtifact?: string;
  patchArtifact?: string;
  usage: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  model?: string;
  startedAt: number;
  endedAt: number;
  error?: { code: string; message: string; retryable: boolean };
  truncated?: boolean;
}
```

Parallel calls do not discard successful siblings when one fails. A workflow decides whether a failed node is fail-fast, optional, retryable, or collected as a failure value.

Retries default to off for write-capable steps. Automatic retry is safe only before any mutating tool call, or inside a fresh disposable worktree.

## 11. Delivery milestones

### Milestone 0 — Contracts and package skeleton

- Package manifest and peer dependencies.
- Agent schema/discovery with trust tests.
- Versioned event/result/run-store types.
- Mock child executable and protocol test harness.
- Configuration loader and doctor command.

Exit: package loads through `pi -e .`, lists built-in agents, and passes unit/type checks.

### Milestone 1 — Foreground single and natural parallel delegation

- `subagent_run`.
- Global scheduler and shared-workspace write lease.
- Isolated JSON-mode child transport.
- Abort/timeout/process-tree cleanup.
- Streaming compact/expanded renderer and usage tracking.
- Built-in scout, planner, reviewer, worker.

Exit: one child works; four sibling `subagent_run` calls execute concurrently but respect the global limit; malformed/hung children fail deterministically.

### Milestone 2 — Background lifecycle and fleet UI

- Detached orchestrator process.
- Durable run artifacts and stale-run reconciliation.
- `subagent_control` list/status/wait/interrupt/stop.
- Footer status, notifications, and fleet overlay.
- Session attribution and shutdown/reload cleanup.

Exit: a background run survives parent UI reload/session switching, remains inspectable, and delivers a single completion notice.

### Milestone 3 — Programmatic workflows

- `defineWorkflow()` and workflow discovery.
- `workflow_run`/`workflow_control`.
- Stable-ID replay, `agent`, `parallel`, `map`, `gate`, structured output.
- Workflow graph projection and approval UI.
- Dynamic fan-out and hard node/concurrency/budget bounds.
- Built-in `scout-plan`, `parallel-review`, and `implement-and-review` workflows.

Exit: kill and restart a workflow runner; completed stable-ID steps are reused and unfinished safe steps resume according to policy.

### Milestone 4 — Worktree writers and reconciliation

- Worktree lifecycle and setup validation.
- Patch/diff capture.
- Serial explicit patch application or reconciliation workflow.
- Conflict reporting and cleanup recovery.

Exit: parallel writers cannot touch the same shared workspace; isolated patches are retained even if merge/application fails.

### Milestone 5 — Stateful/team features, only if justified

- Persistent RPC or SDK-worker transport.
- Follow-up/send/resume on an addressable child.
- Supervisor questions/mailbox.
- Optional bounded nested delegation.
- External sandbox transport interface.

These are deliberately not v1 requirements.

## 12. Test plan

### Unit

- Agent/workflow discovery precedence and project trust.
- Schema validation and model/tool resolution.
- Scheduler fairness, cancellation, fan-out and node caps.
- State transition legality and event reducer determinism.
- UTF-8 chunk splitting, oversized JSONL lines, malformed/final unterminated events.
- Output/stderr truncation.
- Workflow stable-ID memoization, drift detection, replay, gates, and fail-fast/collect behavior.
- Workspace writer classification and lease conflicts.
- Worktree path validation and cleanup.

### Integration with mock child

Simulate:

- Streaming text/tool events.
- Concurrent out-of-order completion.
- Retry/compaction before final settlement.
- Spawn error, nonzero exit, model error, timeout, parent abort.
- Child ignoring TERM and requiring KILL.
- Huge line/output/stderr.
- Runner crash between event append and snapshot replacement.
- Parent reload while background children continue.

### TUI

- Snapshot rendering at widths 40, 60, 80, 120, and 200.
- Assert every rendered line fits width by visible ANSI width.
- Theme invalidation rebuilds pre-colored content.
- Fleet selection survives refresh and list reordering.
- Empty, queued, running, needs-input, mixed-failure, and completed states.

### Optional live E2E

- Real Pi subprocess with a low-cost configured model.
- Single read-only scout.
- Two-agent parallel run.
- Background completion.
- Workflow replay smoke test.

Live-model tests are opt-in and excluded from ordinary CI.

## 13. Explicit non-goals for v1

- An autonomous unlimited “swarm.”
- Automatic recursive child spawning.
- Automatic merge of parallel writer changes.
- A full permission system or security sandbox.
- Distributed execution across machines.
- Cron scheduling.
- Prometheus/OTLP exporters.
- Cross-run long-term agent memory.
- Dozens of tool actions or workflow configuration knobs.
- Guaranteed recovery of arbitrary non-deterministic JavaScript outside stable workflow steps.

## 14. Decisions to confirm before implementation

Recommended defaults:

1. **Package identity:** use `@inv1x/pi-subagents`; the unscoped `pi-subagents` name is already occupied on npm.
2. **Transport:** start with isolated Pi JSON subprocesses; add persistent RPC/SDK workers later.
3. **Tool shape:** one `subagent_run` per child so Pi's native sibling tool calls provide the most Claude-like parallel behavior.
4. **Workflow model:** trusted TypeScript workflows with stable-ID deterministic replay, not only static YAML DAGs.
5. **Background default:** foreground for direct delegation, background for programmatic workflows expected to exceed one minute.
6. **Concurrency:** 4 active children globally; 16 default maximum fan-out; 64 hard configurable ceiling.
7. **Writes:** reject concurrent shared writers; worktree mode opt-in; no auto-merge in v1.
8. **UI:** compact tool rows + footer status first; fleet and graph overlays in milestones 2–3.
9. **Scope:** complete milestones 0–3 for the first useful release, then evaluate worktree and stateful-team demand.
