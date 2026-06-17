# Backend Capabilities

Agent Cockpit supports Claude Code, OpenAI Codex, Kiro, OpenCode, Grok Build, and GitHub Copilot. The exact
feature surface differs because each CLI harness exposes different protocols and
metadata.

The detailed comparison table lives in [BACKENDS.md](../../BACKENDS.md). This
page summarizes the user-facing shape.

## Claude Code

- direct CLI spawn per message;
- plan mode support;
- Ultracode runtime mode for xhigh-capable Claude models in both standard and
  interactive profiles;
- token and cost reporting when exposed by the CLI;
- subagent and tool visualization;
- mid-turn user input;
- one-shot image tasks through the native Claude Code file/image tool path;
- workspace instruction compatibility checks.

## OpenAI Codex

- Codex App Server JSON-RPC transport;
- per-conversation persistent process with idle timeout;
- thread creation and resume;
- goal mode controls;
- subagent demultiplexing;
- token usage tracking;
- MCP injection through spawn-time config overrides;
- one-shot image tasks through Codex's native file/image tool path;
- full local execution defaults through Codex approval/sandbox environment
  values.

## Kiro

- ACP JSON-RPC transport;
- lazy process spawn with idle timeout;
- session creation, loading, and resume across restarts;
- subagent tracking with grouped tool visualization;
- explicit one-shot image attachments over ACP content blocks for image-capable
  Kiro models;
- credits/context reporting rather than token/cost reporting.

## OpenCode

- direct `opencode run --format json` CLI spawn per message;
- self-configured provider credentials and model routing owned by OpenCode;
- model discovery through `opencode models [provider] --verbose` with a plain
  command fallback for older CLIs;
- provider effort variants through `opencode run --variant <effort>` when the
  selected model advertises the requested variant;
- model media capability discovery from verbose `capabilities.input.*` flags;
  media tasks fail closed when a model does not report the required input
  modality;
- one-shot image/PDF attachments through `opencode run --file` when the model
  supports the input modality;
- visible thinking through `opencode run --thinking`, mapped from JSON
  `reasoning` parts into Cockpit thinking blocks;
- session continuity through persisted OpenCode session IDs;
- tool activity visualization for built-in OpenCode tools and MCP tools emitted
  as JSON `tool_use` parts;
- Memory and Knowledge Base MCP injection through per-process
  `OPENCODE_CONFIG_CONTENT`;
- no confirmed native durable-memory directory for Agent Cockpit to import or
  watch. OpenCode memory integration uses Agent Cockpit's Memory MCP tools
  instead of backend-native memory capture.

## Grok Build

- persistent ACP with native xAI extensions and session history recovery;
- shared terminal auth or explicit isolated account profiles;
- thinking, tools, grouped foreground/background subagents, native questions,
  plan approval and mid-turn input;
- native goal set/clear/pause/resume with a soft token budget;
- per-model input/output/cache usage and reported model cost when complete;
- optional profile-specific account tier, quota, balances, and reset date;
- Memory/KB MCP injection and restricted sequential text processor calls;
- verified grok-4.7 image input/output and native PDF input;
- active-turn reattachment, native memory import, audio/video, and unverified
  model modalities remain unsupported.

Native compatibility is verified on Grok Build 1.0.52, macOS arm64. See the
[Grok implementation specification](../spec-grok-build.md) for platform limits.

## GitHub Copilot

- direct `copilot -p <prompt> --output-format json` CLI spawn per message;
- self-configured authentication that reuses the `copilot` CLI login under
  `~/.copilot` (sign in with `copilot` then `/login`); Agent Cockpit checks
  availability with `copilot --version` but does not manage the login;
- curated model catalog (Claude and GPT model identifiers) selectable per
  conversation, since the CLI exposes no machine-readable model listing;
- reasoning effort through `copilot --reasoning-effort <low|medium|high|xhigh>`;
- visible thinking mapped from `assistant.reasoning_delta` JSONL events;
- streaming assistant text mapped from `assistant.message_delta` events;
- tool activity and outcomes mapped from `tool.execution_start` and
  `tool.execution_complete` events;
- session continuity through persisted Copilot session IDs passed back with
  `copilot --resume <sessionId>`;
- one-shot image/PDF attachments through `copilot --attachment <path>`;
- Memory and Knowledge Base MCP injection through
  `copilot --additional-mcp-config <json>`;
- credits-style usage reporting (premium requests plus assistant output tokens);
  Copilot does not expose input tokens or per-turn USD cost, so cost reporting is
  unavailable;
- no plan mode, subagents, mid-turn input, or interactive user questions through
  Agent Cockpit today;
- no confirmed native durable-memory directory for Agent Cockpit to import or
  watch. Copilot memory integration uses Agent Cockpit's Memory MCP tools.
