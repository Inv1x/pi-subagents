# Pi compatibility and upgrade rationale

The supported floor and exact development SDK version are **Pi 1.4.0**. Node.js remains **22.19.0 or newer**. Pi modules are unbundled peer dependencies; exact development pins also keep the isolated SDK child aligned with this baseline.

## Why not stop at 1.0.0?

Pi 1.0.0 is a viable baseline for OpenAI's ChatGPT subscription login, which was introduced in 0.99.0 and had a bundled-login fix in 0.99.1. Requiring 1.4.0 is not necessary merely to recognize those credentials. It is a deliberate reliability baseline for this extension:

| Release | Relevant benefit |
| --- | --- |
| 0.99.0 → 1.0.0 | ChatGPT login on the OpenAI provider, tool exposure/structured output/nested-call APIs, virtual models, terminal-derived themes and perceptual colors; fullscreen becomes the default in 1.0.0. Codemode uses fewer prompt tokens in 1.0.0, but this does not automatically reduce isolated child prompts, which do not load codemode. |
| 1.0.1–1.0.4 | Renderers for tools that are not registered yet; cancellation-safe OAuth refresh; corrected MCP/tool selection, prompt guidelines, and codemode failure handling. |
| 1.1.0 | `agent_settled.aborted`, recorded tool durations in renderer/event contexts, OSC 7501 working/blocked/done/error reporting. |
| 1.2.0 | Extension-triggered custom-message runs receive `before_agent_start`; startup is busy and queues messages correctly; custom-message runs preserve prompt sections after tool calls. Published strict theme/configuration schemas. These changes matter for background completion delivery. |
| 1.3.0 | Overlay `done()` closes its own overlay, not whichever happens to be topmost. Pi's internal package versions are pinned exactly. Resumed sessions restore their active tools. |
| 1.4.0 | Concurrent extension dialogs no longer replace one another and strand promises; summaries use the model's output limit instead of a fixed cap; resumed branches activate newly registered extension tools; terminal teardown and additional transient-retry/tool-history fixes. |

1.4.0 was the latest npm release when this upgrade was made. A single host/SDK baseline is simpler to support and test. Raising the supported minimum is a compatibility change, not a claim that every listed feature is used by this extension.

## Migration checks

- `before_agent_start` is a discriminated user/custom-message union since 1.2.0. The subagent catalog hook only uses shared fields and intentionally applies to both kinds of run; no user-prompt-only guard is needed.
- Mock tool contexts use `ExtensionToolContext`, including `tools` and a fail-closed `executeTool()`. Command-context fixtures include the session-operation methods required by the newer SDK.
- Dependencies and lockfiles pin the same Pi release. CI installs them with `npm ci`; it must not depend on a global Pi or developer-only symlinks.

## Further opportunities, not enabled by this upgrade

1. **Structured tool results and namespaces:** add `outputSchema`/`structuredContent` for agent results, making them usable as data from codemode rather than requiring text parsing. Keep interactive user prompts and orchestration tools `model-only` where nested calls would be unsafe. This needs explicit API and behavior tests.
2. **Cancellation-aware protocol:** consume `agent_settled.aborted` in the legacy CLI transport to distinguish provider-side cancellation from an ordinary incomplete result. Parent cancellation and timeouts already have their own handling.
3. **Recorded timing:** use renderer `durationMs` when displaying completed work instead of recomputing elapsed time where the host already supplies authoritative timings.
4. **Virtual-model routing:** evaluate Pi's native per-request routing for in-session routing needs. It is not a drop-in replacement for the plugin's isolated processes, durable workflows, leases, or canonical child checkpoints.
5. **Modern theme styling:** use `theme.style()`, concrete `theme.colors`, and `theme.appearance` when combining styles or doing color math. Existing `fg()`/`bg()` calls remain supported; no palette rewrite is required.

## Local installation and child SDKs

The parent extension loader supplies Pi's modules, but the isolated child is an ordinary Node process and resolves its own physical SDK dependencies. A peer floor alone cannot prevent a stale development SDK from being loaded by that process. Updating the development pins and lockfile is therefore essential: `npm ci` must install 1.4.0, not restore 0.87.1.

For local checkouts, run `npm ci` after updating. No Homebrew-specific links are required. Keep the host and child SDK versions aligned when upgrading again, and rerun the SDK transport tests and a live model smoke test. Pinning 1.4.0 does not promise automatic alignment with a future host release.

## Sources

- [Pi coding-agent changelog at v1.4.0](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)
- [Extension contracts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)
- [Package dependency guidance](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)
- [SDK lifecycle](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)
