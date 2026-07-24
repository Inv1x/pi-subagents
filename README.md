# pi-subagents

Focused subagents and bounded programmatic workflows for [Pi](https://github.com/earendil-works/pi).

## Features

- One `subagent_run` tool per isolated child, matching Claude Code's simple delegation model.
- Natural parallelism: Pi can emit several sibling `subagent_run` calls in one assistant turn.
- One global scheduler with foreground priority, concurrency limits, and shared-workspace writer leases.
- Foreground and background runs with streaming activity, usage, cancellation, timeout, and bounded output.
- Durable versioned run artifacts under `~/.pi/agent/subagents/runs/`.
- Programmatic TypeScript workflows with stable steps, dynamic fan-out, joins, approval gates, and replay.
- Worktree isolation with patch capture for write-capable children.
- Session-scoped run status and a polished recent-run fleet inspector.
- Built-in `general`, `scout`, `planner`, `reviewer`, and `worker` roles, with task-specific run names that can inherit any role.
- Built-in `scout-plan`, `parallel-review`, and `implement-and-review` workflows.

> Subagents are separate Pi processes, not security sandboxes. They run with your OS account's permissions.

## Install locally

From this repository:

```bash
npm install
pi -e .
```

Or add the absolute repository path to Pi's package settings.

## Basic usage

Ask naturally:

```text
Use the reviewer subagent to inspect the authentication implementation.
```

```text
Run three scouts in parallel: API entry points, tests, and persistence.
```

Pi should emit multiple `subagent_run` calls together for parallel work. Every call still passes through the global scheduler.

Start background work:

```text
Ask scout to map the whole repository in the background.
```

Both `subagent_run` and `workflow_run` accept `background: true`. A background launch returns immediately, so the parent agent can continue useful independent work or end its turn and rely on the completion notification. While a standalone foreground subagent is running, press `Ctrl+B` to move it to the background. Inspect or wait only when the result is needed; status calls are one-shot checks, not a polling loop.

```text
Use subagent_control to list runs and wait for the scout result.
```

The extension adds concise tool-specific system-prompt guidance that encourages proactive delegation, explains foreground versus background launches, and reminds the parent about lifecycle and write-safety constraints.

## Programmatic workflows

```text
Run the scout-plan workflow for adding rate limiting.
```

```text
Run implement-and-review in the background for this request.
```

`implement-and-review` pauses at `approve-plan`. Approve it with `workflow_control` or through the foreground confirmation dialog.

### Authoring a workflow

Create `~/.pi/agent/workflows/example.workflow.ts` or, in a trusted project, `.pi/workflows/example.workflow.ts`:

```ts
import { defineWorkflow } from "@inv1x/pi-subagents/workflow";

export default defineWorkflow({
  name: "review-many",
  description: "Review several areas concurrently",
  async run(ctx, input: { request: string }) {
    const areas = ["API", "database", "tests"];
    const reviews = await ctx.map(
      "reviews",
      areas,
      (area) => ({
        agent: "reviewer",
        task: `Review ${area} for: ${input.request}`,
      }),
      { concurrency: 3 },
    );
    return reviews.map((review) => review.output).join("\n\n---\n\n");
  },
});
```

Stable IDs (`reviews`, `plan`, `implement`, and so on) are part of the durability contract. On resume, completed steps with the same normalized specification are reused. A changed specification produces a workflow-drift error rather than silently repeating side effects. Agent-step results include the actual model, thinking effort, usage, cost, and artifact paths.

Workflow context methods:

- `ctx.agent(stepId, spec)`
- `ctx.parallel(groupId, specs, options?)`
- `ctx.map(groupId, items, factory, options?)`
- `ctx.gate(gateId, { title, summary })`
- `ctx.output(stepId)`
- `ctx.log(message, data?)`
- `ctx.setResult(value)`
- `ctx.signal`

Project TypeScript workflows are arbitrary local code and require project trust plus a launch preview by default.

## Custom agents

Create `~/.pi/agent/agents/reviewer.md` or `.pi/agents/reviewer.md` in a trusted project:

```markdown
---
name: reviewer
description: Reviews code without editing
tools: read, grep, find, ls
model: inherit
thinking: medium
context: fresh
workspace: shared
maxTurns: 128
timeoutMs: 3600000
---

Review correctness, tests, security, and unnecessary complexity.
Return actionable findings with file and line evidence.
```


Supported frontmatter:

- `name`, `description`, `tools`
- `model`, `thinking`
- `context: fresh | summary`
- `workspace: shared | worktree`
- `maxTurns`, `timeoutMs`
- `skills` (parsed; explicit child skill-path loading is planned)
- `systemPromptMode: replace | append`
- `inheritProjectContext`

Discovery precedence is built-in, user, then trusted project. Project definitions override the same agent name.

## Model and effort selection

Every child gets an explicit model and thinking effort. Selection precedence is:

1. `subagent_run` or workflow-step override
2. Agent frontmatter (`model`, `thinking`)
3. The parent Pi session's currently selected model and thinking level

`model: inherit` therefore follows the live parent selection rather than merely falling back to global defaults. The extension passes the resolved values through Pi's `--model` and `--thinking` flags, then records the actual provider/model reported by the child alongside tokens, cost, and effort in the durable run status.

Compact run rows show the selected model and effort for that individual run. The fleet status intentionally omits a single model because concurrent children can use different configurations. Expanded output and `/subagents-fleet` retain the full model and usage details.

The child transport passes the canonical model through `--model` and the clamped effort through `--thinking`. Run metadata records the requested model/effort and the model reported by Pi; a reported selected-model mismatch fails the run instead of silently falling back. Concrete upstream `responseModel` values are retained when providers expose them.

Children run with `--no-session` because this package owns their durable artifacts. Session-file-only usage trackers therefore see the parent session but not child requests; use the per-run status files or fleet totals for authoritative child usage.

## Tools

### `subagent_run`

Runs one child. `agent` is a descriptive run name such as `task-auditor`. Set `baseAgent` to an exact discovered definition such as `reviewer` to inherit its prompt, tools, and defaults. If `baseAgent` is omitted, an exact `agent` match is used; otherwise the child falls back to `general`.

Omit `model` to inherit the parent's current provider/model; overrides must be exact provider/model identifiers.

```text
Run task-auditor based on reviewer to inspect the current task implementation.
```

Important options:

- `baseAgent`
- `background`
- `context`
- `model`, `thinking`
- `cwd`
- `workspace`
- `timeoutMs`, `maxTurns`, `maxRetries`
- `agentScope: user | project | both` (defaults to `both` in trusted projects, otherwise `user`)

Usually omit `timeoutMs` and `maxTurns`. Built-in agents default to one hour and 128 assistant turns; explicit values are hard safety ceilings, and low ad hoc caps can terminate broad work before it returns a useful handoff.

### `subagent_control`

Actions: `list`, `status`, `wait`, `interrupt`, `stop`.

`send` is reserved for the future persistent RPC/SDK child transport and currently returns an explicit unsupported error.

### `workflow_run`

Runs a named TypeScript workflow with arbitrary JSON-compatible input.

### `workflow_control`

Actions: `list`, `status`, `wait`, `approve`, `reject`, `stop`, `resume`.

## Commands

- `/subagents`
- `/subagents-fleet`
- `/subagents-stop [runId]`
- `/workflows`
- `/workflow-run <name> [--bg] <input>`
- `/workflow-status [runId]`
- `/subagents-doctor`

## Configuration

User configuration: `~/.pi/agent/pi-subagents.json`

Trusted project override: `.pi/pi-subagents.json`

```json
{
  "maxConcurrency": 4,
  "maxWorkflowConcurrency": 4,
  "maxFanout": 16,
  "hardMaxFanout": 64,
  "maxWorkflowNodes": 100,
  "defaultTimeoutMs": 3600000,
  "defaultMaxTurns": 128,
  "maxRetries": 2,
  "retryBaseDelayMs": 2000,
  "resultMaxBytes": 51200,
  "transcriptMaxEvents": 500,
  "retentionDays": 30,
  "showStatus": true,
  "confirmProjectAgents": true,
  "confirmProjectWorkflows": true
}
```

## Write safety and worktrees

An agent with `bash`, `edit`, or `write` is conservatively write-capable.

- Read-only children may run concurrently in a shared workspace.
- Shared-workspace writers are serialized by a workspace lease.
- Choose `workspace: "worktree"` for parallel writers.
- Worktree mode requires a clean Git repository.
- The extension captures changes as `changes.patch`, then removes the temporary worktree and branch.
- It does not auto-merge parallel patches.

## Artifacts

Each run has a private directory:

```text
~/.pi/agent/subagents/runs/<run-id>/
├── manifest.json
├── status.json
├── events.jsonl
├── workflow.json          # workflows only
├── system-prompt.md       # child runs
├── output.md
├── transcript.log
└── changes.patch          # worktree changes, when present
```

Model-visible output is capped; full output remains in `output.md`. JSON event lines and stderr are independently bounded.

After Pi exhausts its own provider-level retries, the extension retries a child process for recognized transient failures such as WebSocket disconnects, connection resets, rate limits, and 5xx responses. Retries use bounded exponential backoff, preserve cumulative usage/cost and attempt history, and stay within the original run timeout. To avoid repeating side effects, the extension does not restart a child after it has invoked `bash`, `edit`, or `write`. Set `maxRetries` to `0` globally or per run to disable process-level retries.

The current session's active fleet is summarized in one compact status line. Finished runs remain visible for five minutes, matching the inspector's recent-run window. Open the fleet inspector with `/subagents-fleet`; with `pi-ui-customization` loaded, an empty editor can use Up/Down to select the footer status and Enter to open it. That navigation is owned by the editor only, so selectors and overlays keep normal ownership of their keys. The inspector groups workflow children beneath their parent, uses state-colored markers, and shows run metadata and scrollable output in a separate panel. Use Up/Down to select runs, `g`/`G` to jump, and `j`/`k` to scroll output. Detailed output remains available through the control tools. Set `showStatus` to `false` to hide the summary; the former `showWidget: false` setting is still honored for compatibility.

## Background lifecycle

Background work returns control to the parent immediately and survives parent turns, Pi session switches, and extension reloads inside the same Pi process through a process-global runtime. Runs continue globally, but status, costs, notifications, fleet views, commands, and control tools are projected only into the owning Pi session.

A full Pi process exit stops owned work. On the next startup, unfinished persisted runs are marked `orphaned`; workflows can be explicitly resumed and replay completed stable steps.

This release does not yet run a fully detached durable orchestrator daemon.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e . --list-models
```

Tests cover protocol framing and limits, scheduler concurrency/resource leases, trust-aware discovery, child JSON event parsing, compact UI rendering, status projection, and workflow fan-out/gates/persistence.

See [`PLAN.md`](PLAN.md) for the product research, architecture decisions, UI rationale, and later milestones.
