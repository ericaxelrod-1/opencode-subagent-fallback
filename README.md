# opencode-subagent-fallback

Automatic, transparent model and provider failover for OpenCode main sessions and spawned subagents.

When an active model hits rate limits, transient server overloads, quota exhaustion, authentication/provider errors, context-window limits, or stalled streams, the plugin automatically switches to the next healthy fallback candidate configured in `~/.config/opencode/fallback.json` and keeps the session moving without manual intervention.

## Core Capabilities

- **In-flight failover:** Handles rate limits (HTTP 429), quota exhaustion (HTTP 402 / daily limits), auth/forbidden errors, missing models, 5xx provider failures, and context-length overflows.
- **Per-agent fallback chains:** Supports dedicated fallback lists and semantic model options (`temperature`, `reasoningEffort`, `thinking`) per agent, plus global defaults.
- **Sticky retries, cooldowns & circuit breakers:** Absorbs brief transient blips with fast sticky retries, respects `Retry-After` and quota reset windows, and benches unhealthy models via per-model circuit breakers.
- **Context-overflow pre-emption & dynamic compaction curve:** Dynamically triggers proactive self-compaction along a logarithmic scale (85% on <=32k models down to 40% on 1M+ models) and routes oversized conversations to large-context fallback models before requests overflow.
- **Liveness watchdog:** Detects hung streams and stalled turns while protecting active tool/subagent waits and retry sleeps.

## Repository Structure

This repository contains two implementations targeting different OpenCode plugin APIs:

| Directory | Target | Description | Documentation |
| --- | --- | --- | --- |
| [`opencode_v2/`](opencode_v2) | **OpenCode 2.x** (active) | Native V2 hook-driven plugin (`session.hook("retry")`, `prompt`, `context`, `experimental.idle`, `tool.transform`, `agent.transform`, and `event` stream) with in-step `switchModel`, multi-pass cycling, and 10-attempt step rollover. | [V2 README](opencode_v2/README.md) |
| [`opencode_v1/`](opencode_v1) | **OpenCode 1.x** (legacy reference) | Original V1 plugin implementation using `fetch` interception and synthetic-turn failover. Kept as reference for V1 behavior and parity. | [V1 README](opencode_v1/README.md) |

## Shared Configuration & Logs

- **Config:** `~/.config/opencode/fallback.json` (JSON with comments; hot-reloaded on change)
- **Logs:** `~/.local/share/opencode/log/fallback.log`
