import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotAttachment, type RunOneShotOptions } from './base';
import { extractToolOutcome, shortenPath } from './toolUtils';
import {
  buildNativeSessionRecovery,
  buildSessionRecoveryEvent,
  createRecoverySnapshot,
  isMissingNativeSessionError,
} from './sessionRecovery';
import { buildCliCommandInvocation, resolveCliCommandForRuntime, type CliCommandResolution } from '../cliCommandResolver';
import { logger } from '../../utils/logger';
import type {
  BackendMetadata,
  CliProfile,
  EffortLevel,
  McpServerConfig,
  ModelCapabilities,
  ModelOption,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Usage,
} from '../../types';

// GitHub Copilot mark — simple rounded badge so the cockpit can render an
// assistant avatar and harness icon without depending on an external asset.
const COPILOT_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" fill="#0D1117"/><path d="M12 6.4c-3.7 0-6.2 1.7-6.2 1.7-.5-1.3-.4-2.6-.4-2.6S4.1 6.6 4.1 8.5c-.5.6-.8 1.4-.8 2.4v2.2c0 2.9 3.9 4.7 8.7 4.7s8.7-1.8 8.7-4.7v-2.2c0-1-.3-1.8-.8-2.4 0-1.9-1.3-3-1.3-3s.1 1.3-.4 2.6c0 0-2.5-1.7-6.2-1.7Z" fill="#fff"/><path d="M9 11.4c-.9 0-1.6.9-1.6 2s.7 2 1.6 2 1.6-.9 1.6-2-.7-2-1.6-2Zm6 0c-.9 0-1.6.9-1.6 2s.7 2 1.6 2 1.6-.9 1.6-2-.7-2-1.6-2Z" fill="#0D1117"/></svg>';

const COPILOT_EXEC_TIMEOUT_MS = 60_000;
const COPILOT_EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const COPILOT_EFFORT_SET = new Set<string>(COPILOT_EFFORT_ORDER);
const copilotLog = logger.child({ module: 'copilot-backend' });

const TEXT_IMAGE_MODEL_CAPABILITIES: ModelCapabilities = {
  input: { text: true, image: true },
  output: { text: true },
  reasoning: true,
};

interface CopilotModelSeed {
  id: string;
  family: string;
  costTier: 'high' | 'medium' | 'low';
  description: string;
  default?: boolean;
}

// Curated catalog. GitHub Copilot CLI has no machine-readable `models` listing,
// so the available model identifiers are tracked here (see `copilot help config`).
const COPILOT_MODEL_SEEDS: CopilotModelSeed[] = [
  { id: 'claude-sonnet-4.6', family: 'claude', costTier: 'medium', description: 'Balanced Claude Sonnet model for everyday agentic coding', default: true },
  { id: 'claude-sonnet-4.5', family: 'claude', costTier: 'medium', description: 'Previous Claude Sonnet generation' },
  { id: 'claude-haiku-4.5', family: 'claude', costTier: 'low', description: 'Fast, low-cost Claude Haiku model' },
  { id: 'claude-opus-4.7', family: 'claude', costTier: 'high', description: 'Strong Claude Opus model for complex reasoning' },
  { id: 'claude-opus-4.6', family: 'claude', costTier: 'high', description: 'Claude Opus model for complex reasoning' },
  { id: 'claude-opus-4.6-fast', family: 'claude', costTier: 'high', description: 'Latency-optimized Claude Opus variant' },
  { id: 'claude-opus-4.5', family: 'claude', costTier: 'high', description: 'Previous Claude Opus generation' },
  { id: 'gpt-5.5', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-5.5 reasoning model' },
  { id: 'gpt-5.4', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.4 model' },
  { id: 'gpt-5.3-codex', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.3 Codex coding model' },
  { id: 'gpt-5.2-codex', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.2 Codex coding model' },
  { id: 'gpt-5.2', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.2 model' },
  { id: 'gpt-5.4-mini', family: 'gpt', costTier: 'low', description: 'Fast, low-cost GPT-5.4 mini model' },
  { id: 'gpt-5-mini', family: 'gpt', costTier: 'low', description: 'Fast, low-cost GPT-5 mini model' },
  { id: 'gpt-4.1', family: 'gpt', costTier: 'low', description: 'OpenAI GPT-4.1 model' },
];

const COPILOT_MODELS: ModelOption[] = COPILOT_MODEL_SEEDS.map(seed => ({
  id: seed.id,
  label: seed.id,
  family: seed.family,
  description: seed.description,
  costTier: seed.costTier,
  ...(seed.default ? { default: true } : {}),
  supportedEffortLevels: [...COPILOT_EFFORT_ORDER],
  capabilities: TEXT_IMAGE_MODEL_CAPABILITIES,
}));

export interface CopilotCliRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
  profileKey: string;
}

export function resolveCopilotCliRuntime(profile?: CliProfile): CopilotCliRuntime {
  if (profile && profile.harness !== 'copilot') {
    throw new Error(`CLI profile harness ${profile.harness} is not copilot`);
  }

  const requestedCommand = profile?.command?.trim() || 'copilot';
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (profile?.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      env[key] = value;
    }
  }

  const hash = crypto.createHash('sha1').update(JSON.stringify({
    id: profile?.id || null,
    command: requestedCommand,
    env: profile?.env || {},
  })).digest('hex').slice(0, 12);
  const commandResolution = resolveCliCommandForRuntime('copilot', requestedCommand, env);

  return {
    ...commandResolution,
    env,
    profileKey: profile ? `${profile.id}:${hash}` : `server-configured:${hash}`,
  };
}

interface CopilotRunResult {
  text: string;
  sessionId: string | null;
  usage: Usage | null;
}

interface StreamState {
  proc: ChildProcess | null;
  aborted: boolean;
}

interface CopilotLineInfo {
  sessionId: string | null;
  messageId: string | null;
  deltaMessageId: string | null;
  outputTokens: number;
  premiumRequests: number;
  isResult: boolean;
}

export class CopilotAdapter extends BaseBackendAdapter {
  constructor(options: { workingDir?: string } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.agent-cockpit', 'workspace');
  }

  get metadata(): BackendMetadata {
    return {
      id: 'copilot',
      label: 'GitHub Copilot',
      icon: COPILOT_ICON,
      capabilities: {
        thinking: true,
        planMode: false,
        agents: false,
        toolActivity: true,
        userQuestions: false,
        stdinInput: false,
        oneShotMediaInput: {
          image: ['explicit-attachment'],
          pdf: ['explicit-attachment'],
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'The GitHub Copilot CLI runs one non-interactive process per turn and does not expose a way to reattach to an already-running turn stream.',
        sessionResume: 'supported',
        sessionResumeReason: 'The adapter persists Copilot session IDs via external_session and passes them back with copilot --resume on later turns.',
      },
      models: COPILOT_MODELS,
    };
  }

  async getMetadata(_options: BackendCallOptions = {}): Promise<BackendMetadata> {
    return this.metadata;
  }

  sendMessage(message: string, options: SendMessageOptions): SendMessageResult {
    const state: StreamState = { proc: null, aborted: false };
    return {
      stream: this._streamMessage(message, options, state),
      abort: () => {
        state.aborted = true;
        state.proc?.kill('SIGTERM');
      },
      sendInput: () => {},
    };
  }

  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    const workingDir = resolveCopilotWorkingDir(options.workingDir || this.workingDir || process.cwd());
    const runtime = resolveCopilotCliRuntime(options.cliProfile);
    const args = buildCopilotRunArgs(prompt, {
      workingDir,
      model: options.model,
      effort: options.effort,
      allowTools: options.allowTools,
      mcpServers: options.mcpServers,
      attachments: options.attachments,
    });
    const result = await runCopilotOnce(runtime, args, {
      cwd: workingDir,
      timeoutMs: options.timeoutMs ?? COPILOT_EXEC_TIMEOUT_MS,
      abortSignal: options.abortSignal,
    });
    return result.text.trim();
  }

  async generateSummary(messages: { role: string; content: string }[], fallback: string, options?: BackendCallOptions): Promise<string> {
    const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Summarize this conversation in one concise paragraph.\n\n${transcript}`;
    try {
      const summary = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: COPILOT_EXEC_TIMEOUT_MS });
      return summary.trim().slice(0, 200) || fallback;
    } catch {
      return fallback;
    }
  }

  async generateTitle(userMessage: string, fallback: string, options?: BackendCallOptions): Promise<string> {
    const prompt = `Generate a concise conversation title of at most 8 words for this message. Return only the title.\n\n${userMessage}`;
    try {
      const title = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: COPILOT_EXEC_TIMEOUT_MS });
      return title.replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
    } catch {
      return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }
  }

  private async *_streamMessage(message: string, options: SendMessageOptions, state: StreamState): AsyncGenerator<StreamEvent> {
    yield* this._streamMessageAttempt(message, options, state, false);
  }

  private async *_streamMessageAttempt(
    message: string,
    options: SendMessageOptions,
    state: StreamState,
    retryingAfterRecovery: boolean,
  ): AsyncGenerator<StreamEvent> {
    let proc: ChildProcess;
    let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
    let workingDir: string;
    try {
      workingDir = resolveCopilotWorkingDir(options.workingDir || this.workingDir || process.cwd());
      const runtime = resolveCopilotCliRuntime(options.cliProfile);
      const prompt = composePrompt(message, options.systemPrompt, options.isNewSession);
      const args = buildCopilotRunArgs(prompt, {
        workingDir,
        model: options.model,
        effort: options.effort,
        externalSessionId: options.isNewSession ? null : options.externalSessionId,
        mcpServers: options.mcpServers,
        allowTools: true,
      });
      const invocation = buildCliCommandInvocation(runtime, args);
      proc = spawn(invocation.command, invocation.args, {
        cwd: workingDir,
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      exitPromise = waitForExit(proc);
    } catch (err: unknown) {
      yield { type: 'error', error: formatCopilotProcessError(err as Error & { code?: string }) };
      yield { type: 'done' };
      return;
    }
    state.proc = proc;

    yield { type: 'backend_runtime', processId: proc.pid ?? null };

    try {
      const stderrChunks: string[] = [];
      proc.stderr?.on('data', chunk => stderrChunks.push(chunk.toString()));

      let emittedSessionId: string | null = null;
      let outputTokens = 0;
      let premiumRequests = 0;
      let sawResultUsage = false;
      const emittedToolActivityIds = new Set<string>();
      const deltaTextByMessageId = new Map<string, boolean>();
      let buffer = '';

      const handleLine = function* (this: CopilotAdapter, line: string): Generator<StreamEvent> {
        const info = copilotLineInfo(line);
        outputTokens += info.outputTokens;
        premiumRequests += info.premiumRequests;
        if (info.deltaMessageId) deltaTextByMessageId.set(info.deltaMessageId, true);

        for (const event of translateCopilotLine(line)) {
          if (event.type === 'external_session') {
            if (event.sessionId && event.sessionId !== emittedSessionId) {
              emittedSessionId = event.sessionId;
              yield event;
              yield { type: 'backend_runtime', externalSessionId: event.sessionId, processId: proc.pid ?? null };
            }
            continue;
          }
          if (event.type === 'tool_activity' && event.id) {
            if (emittedToolActivityIds.has(event.id)) continue;
            emittedToolActivityIds.add(event.id);
          }
          yield event;
        }

        // Final message text fallback when no streaming deltas were produced
        // for this assistant message (e.g. streaming disabled).
        const fallback = copilotFinalMessageText(line);
        if (fallback && fallback.text && !deltaTextByMessageId.get(fallback.messageId)) {
          yield { type: 'text', content: fallback.text, streaming: false };
        }

        if (info.isResult) {
          sawResultUsage = true;
          yield { type: 'usage', usage: copilotUsage(outputTokens, premiumRequests) };
        }
      }.bind(this);

      for await (const chunk of proc.stdout || []) {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          yield* handleLine(line);
        }
      }
      if (buffer.trim()) {
        yield* handleLine(buffer);
      }

      const exit = await exitPromise;
      if (exit.error && !state.aborted) {
        yield { type: 'error', error: formatCopilotProcessError(exit.error) };
        yield { type: 'done' };
        return;
      }
      if (exit.code !== 0 && !state.aborted) {
        const stderr = stripAnsi(stderrChunks.join('\n')).trim();
        if (
          !retryingAfterRecovery
          && !options.isNewSession
          && options.externalSessionId
          && isMissingNativeSessionError(stderr)
        ) {
          const reason = stderr || `Copilot session not found: ${options.externalSessionId}`;
          let snapshot = null;
          try {
            snapshot = await createRecoverySnapshot(options, {
              previousNativeSessionId: options.externalSessionId,
              reason,
            });
          } catch (snapshotErr) {
            copilotLog.warn('Failed to create Copilot session recovery snapshot', {
              sessionId: options.externalSessionId,
              error: (snapshotErr as Error).message,
            });
          }
          const recovery = buildNativeSessionRecovery({
            backend: 'copilot',
            previousNativeSessionId: options.externalSessionId,
            newNativeSessionId: null,
            reason,
            snapshot,
            currentPrompt: message,
          });
          yield buildSessionRecoveryEvent(recovery.metadata);
          yield* this._streamMessageAttempt(recovery.prompt, {
            ...options,
            isNewSession: true,
            externalSessionId: null,
          }, state, true);
          return;
        }
        yield { type: 'error', error: stderr || `Copilot exited with code ${exit.code ?? 'unknown'}` };
      }
      if (!sawResultUsage && outputTokens > 0 && !state.aborted) {
        yield { type: 'usage', usage: copilotUsage(outputTokens, premiumRequests) };
      }
      yield { type: 'done' };
    } catch (err: unknown) {
      if (state.aborted) {
        yield { type: 'error', error: 'Copilot turn aborted.', source: 'abort' };
      } else {
        yield { type: 'error', error: (err as Error).message || String(err) };
      }
      yield { type: 'done' };
    }
  }
}

function buildCopilotRunArgs(prompt: string, options: {
  workingDir?: string | null;
  model?: string;
  effort?: EffortLevel;
  externalSessionId?: string | null;
  mcpServers?: McpServerConfig[];
  allowTools?: boolean;
  attachments?: RunOneShotAttachment[];
}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--no-ask-user', '--no-color', '--log-level', 'none'];

  const broadAccess = options.allowTools || (Array.isArray(options.mcpServers) && options.mcpServers.length > 0);
  // --allow-all-tools is required for non-interactive mode. The chat and
  // tool-using paths also need filesystem and URL access, matching the
  // cockpit's local full-execution model.
  args.push(broadAccess ? '--allow-all' : '--allow-all-tools');

  const model = options.model?.trim();
  if (model) args.push('--model', model);

  if (options.effort && COPILOT_EFFORT_SET.has(options.effort)) {
    args.push('--reasoning-effort', options.effort);
  }

  for (const filePath of copilotAttachmentFiles(options.attachments)) {
    args.push('--attachment', filePath);
  }

  const mcpConfig = copilotMcpConfig(options.mcpServers);
  if (mcpConfig) args.push('--additional-mcp-config', mcpConfig);

  if (options.externalSessionId) args.push('--resume', options.externalSessionId);

  return args;
}

function copilotAttachmentFiles(attachments: RunOneShotAttachment[] | undefined): string[] {
  const files: string[] = [];
  for (const attachment of attachments || []) {
    if (attachment.kind !== 'image' && attachment.kind !== 'pdf') continue;
    const filePath = attachment.path?.trim();
    if (filePath) files.push(filePath);
  }
  return files;
}

function copilotMcpConfig(mcpServers: McpServerConfig[] | undefined): string | null {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return null;
  const servers: Record<string, unknown> = {};
  for (const server of mcpServers) {
    if (!server?.name || !server.command) continue;
    const env: Record<string, string> = {};
    for (const entry of server.env || []) {
      if (entry?.name && typeof entry.value === 'string') env[entry.name] = entry.value;
    }
    servers[server.name] = {
      type: 'local',
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      tools: ['*'],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if (Object.keys(servers).length === 0) return null;
  return JSON.stringify({ mcpServers: servers });
}

function composePrompt(message: string, systemPrompt: string | undefined, isNewSession: boolean): string {
  const system = isNewSession ? String(systemPrompt || '').trim() : '';
  if (!system) return message;
  return `System instructions:\n${system}\n\nUser message:\n${message}`;
}

function copilotUsage(outputTokens: number, premiumRequests: number): Usage {
  return {
    inputTokens: 0,
    outputTokens: Math.max(0, Math.round(outputTokens)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costSource: 'none',
    ...(premiumRequests > 0 ? { credits: premiumRequests } : {}),
  };
}

async function runCopilotOnce(runtime: CopilotCliRuntime, args: string[], options: {
  cwd?: string | null;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<CopilotRunResult> {
  const invocation = buildCliCommandInvocation(runtime, args);
  return await new Promise<CopilotRunResult>((resolve, reject) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || undefined,
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (result: CopilotRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      fail(new Error('Copilot command timed out'));
    }, options.timeoutMs);
    const onAbort = () => {
      proc.kill('SIGTERM');
      fail(new Error('Copilot command aborted'));
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => fail(new Error(formatCopilotProcessError(err as Error & { code?: string }))));
    proc.on('close', code => {
      if (code !== 0) {
        fail(new Error(stripAnsi(stderr).trim() || `Copilot exited with code ${code ?? 'unknown'}`));
        return;
      }
      succeed(collectCopilotJson(stdout));
    });
  });
}

function collectCopilotJson(stdout: string): CopilotRunResult {
  let sessionId: string | null = null;
  let outputTokens = 0;
  let premiumRequests = 0;
  const deltaTextByMessageId = new Map<string, string>();
  const finalTextByMessageId = new Map<string, string>();
  const messageOrder: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const info = copilotLineInfo(line);
    if (info.sessionId) sessionId = info.sessionId;
    outputTokens += info.outputTokens;
    premiumRequests += info.premiumRequests;

    const parsed = safeParse(line);
    if (!parsed) continue;
    if (parsed.type === 'assistant.message_delta' && parsed.data) {
      const messageId = stringOrNull(parsed.data.messageId) || 'default';
      const delta = typeof parsed.data.deltaContent === 'string' ? parsed.data.deltaContent : '';
      if (delta) {
        if (!deltaTextByMessageId.has(messageId)) messageOrder.push(messageId);
        deltaTextByMessageId.set(messageId, (deltaTextByMessageId.get(messageId) || '') + delta);
      }
    } else if (parsed.type === 'assistant.message' && parsed.data) {
      const messageId = stringOrNull(parsed.data.messageId) || 'default';
      const content = typeof parsed.data.content === 'string' ? parsed.data.content : '';
      if (content) {
        if (!deltaTextByMessageId.has(messageId) && !finalTextByMessageId.has(messageId)) messageOrder.push(messageId);
        finalTextByMessageId.set(messageId, content);
      }
    }
  }

  const text = messageOrder
    .map(messageId => deltaTextByMessageId.get(messageId) || finalTextByMessageId.get(messageId) || '')
    .join('')
    .trim();

  return {
    text,
    sessionId,
    usage: outputTokens > 0 || premiumRequests > 0 ? copilotUsage(outputTokens, premiumRequests) : null,
  };
}

function translateCopilotLine(line: string): StreamEvent[] {
  const parsed = safeParse(line);
  if (!parsed) return [];
  const type = parsed.type;
  const data = parsed.data;
  const events: StreamEvent[] = [];

  if (type === 'assistant.message_delta' && data && typeof data.deltaContent === 'string' && data.deltaContent) {
    events.push({ type: 'text', content: data.deltaContent, streaming: true });
  } else if (type === 'assistant.reasoning_delta' && data && typeof data.deltaContent === 'string' && data.deltaContent) {
    events.push({ type: 'thinking', content: data.deltaContent, streaming: true });
  } else if (type === 'tool.execution_start' && data) {
    events.push(...copilotToolStartEvents(data));
  } else if (type === 'tool.execution_complete' && data) {
    events.push(...copilotToolCompleteEvents(data));
  } else if (type === 'result') {
    const sessionId = stringOrNull(parsed.sessionId);
    if (sessionId) events.push({ type: 'external_session', sessionId });
  }

  return events;
}

function copilotToolStartEvents(data: Record<string, unknown>): StreamEvent[] {
  const detail = copilotToolDetail(data);
  if (!detail) return [];
  return [{ type: 'tool_activity', ...detail }];
}

function copilotToolCompleteEvents(data: Record<string, unknown>): StreamEvent[] {
  const id = stringOrNull(data.toolCallId);
  if (!id) return [];
  const rawName = stringOrNull(data.toolName) || '';
  const tool = canonicalCopilotToolName(rawName);
  const success = data.success !== false;
  const result = isRecord(data.result) ? data.result : {};
  const content = typeof result.content === 'string' ? result.content : '';
  const outcome = success
    ? (extractToolOutcome(tool, content) || { outcome: 'done', status: 'success' as const })
    : { outcome: 'error', status: 'error' as const };
  return [{
    type: 'tool_outcomes',
    outcomes: [{
      toolUseId: id,
      isError: !success,
      outcome: outcome.outcome,
      status: outcome.status,
    }],
  }];
}

function copilotToolDetail(data: Record<string, unknown>): {
  tool: string;
  description: string;
  id: string | null;
} | null {
  const rawName = stringOrNull(data.toolName);
  if (!rawName) return null;
  const id = stringOrNull(data.toolCallId);
  const input = isRecord(data.arguments) ? data.arguments : {};

  const mcp = copilotMcpToolName(rawName);
  if (mcp) {
    return { tool: mcp.tool, id, description: `${mcp.server}.${mcp.tool}` };
  }

  const canonical = canonicalCopilotToolName(rawName);
  switch (canonical) {
    case 'Read': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Read', id, description: filePath ? `Reading \`${shortenPath(filePath)}\`` : 'Reading file' };
    }
    case 'Write': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Write', id, description: filePath ? `Writing \`${shortenPath(filePath)}\`` : 'Writing file' };
    }
    case 'Edit': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Edit', id, description: filePath ? `Editing \`${shortenPath(filePath)}\`` : 'Editing file' };
    }
    case 'Bash': {
      const description = firstString(input.description);
      const command = firstString(input.command, input.cmd);
      if (description) return { tool: 'Bash', id, description };
      const short = command && command.length > 60 ? command.slice(0, 60) + '...' : command;
      return { tool: 'Bash', id, description: short ? `Running: \`${short}\`` : 'Running command' };
    }
    case 'Grep': {
      const pattern = firstString(input.pattern, input.query);
      return { tool: 'Grep', id, description: pattern ? `Searching for \`${pattern}\`` : 'Searching files' };
    }
    case 'Glob': {
      const pattern = firstString(input.pattern);
      return { tool: 'Glob', id, description: pattern ? `Finding files matching \`${pattern}\`` : 'Finding files' };
    }
    case 'WebFetch': {
      const url = firstString(input.url);
      return { tool: 'WebFetch', id, description: url ? `Fetching: ${url}` : 'Fetching web content' };
    }
    case 'WebSearch': {
      const query = firstString(input.query, input.q);
      return { tool: 'WebSearch', id, description: query ? `Searching: \`${query}\`` : 'Searching the web' };
    }
    default:
      return { tool: canonical, id, description: `Using ${canonical}` };
  }
}

function canonicalCopilotToolName(rawName: string): string {
  const normalized = rawName.replace(/[-_\s]/g, '').toLowerCase();
  const map: Record<string, string> = {
    bash: 'Bash',
    shell: 'Bash',
    runcommand: 'Bash',
    view: 'Read',
    read: 'Read',
    readfile: 'Read',
    create: 'Write',
    write: 'Write',
    writefile: 'Write',
    str_replace: 'Edit',
    strreplace: 'Edit',
    strreplaceeditor: 'Edit',
    edit: 'Edit',
    editfile: 'Edit',
    grep: 'Grep',
    search: 'Grep',
    glob: 'Glob',
    list: 'List',
    ls: 'List',
    webfetch: 'WebFetch',
    fetch: 'WebFetch',
    websearch: 'WebSearch',
    reportintent: 'Intent',
  };
  return map[normalized] || titleCase(rawName);
}

function copilotMcpToolName(rawName: string): { server: string; tool: string } | null {
  const knownPrefixes = ['agent-cockpit-memory_', 'agent-cockpit-kb-search_'];
  for (const prefix of knownPrefixes) {
    if (rawName.startsWith(prefix)) {
      return { server: prefix.slice(0, -1), tool: rawName.slice(prefix.length) };
    }
  }
  return null;
}

function copilotLineInfo(line: string): CopilotLineInfo {
  const empty: CopilotLineInfo = {
    sessionId: null,
    messageId: null,
    deltaMessageId: null,
    outputTokens: 0,
    premiumRequests: 0,
    isResult: false,
  };
  const parsed = safeParse(line);
  if (!parsed) return empty;

  if (parsed.type === 'result') {
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    return {
      ...empty,
      sessionId: stringOrNull(parsed.sessionId),
      premiumRequests: numberOrZero(usage.premiumRequests),
      isResult: true,
    };
  }
  if (parsed.type === 'assistant.message' && isRecord(parsed.data)) {
    return {
      ...empty,
      messageId: stringOrNull(parsed.data.messageId),
      outputTokens: numberOrZero(parsed.data.outputTokens),
    };
  }
  if (parsed.type === 'assistant.message_delta' && isRecord(parsed.data)) {
    const messageId = stringOrNull(parsed.data.messageId);
    const hasDelta = typeof parsed.data.deltaContent === 'string' && parsed.data.deltaContent.length > 0;
    return { ...empty, deltaMessageId: hasDelta ? messageId : null };
  }
  return empty;
}

function copilotFinalMessageText(line: string): { messageId: string; text: string } | null {
  const parsed = safeParse(line);
  if (!parsed || parsed.type !== 'assistant.message' || !isRecord(parsed.data)) return null;
  const content = typeof parsed.data.content === 'string' ? parsed.data.content.trim() : '';
  if (!content) return null;
  return { messageId: stringOrNull(parsed.data.messageId) || 'default', text: content };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function safeParse(line: string): Record<string, any> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function titleCase(raw: string): string {
  const parts = raw.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return raw;
  return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function resolveCopilotWorkingDir(workingDir: string | null | undefined): string {
  const cwd = workingDir?.trim() || process.cwd();
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      throw new Error(`Copilot working directory is not a directory: ${cwd}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Copilot working directory does not exist: ${cwd}`);
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Error(`Copilot working directory is not a directory: ${cwd}`);
    }
    throw err;
  }
  return cwd;
}

function formatCopilotProcessError(err: Error & { code?: string }): string {
  return err.code === 'ENOENT'
    ? 'GitHub Copilot CLI is not installed or is not available on PATH.'
    : err.message || String(err);
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  return new Promise(resolve => {
    let settled = false;
    proc.once('error', err => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, error: err });
    });
    proc.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });
}

export const __copilotTestUtils = {
  buildCopilotRunArgs,
  collectCopilotJson,
  copilotLineInfo,
  copilotMcpConfig,
  canonicalCopilotToolName,
  resolveCopilotCliRuntime,
  resolveCopilotWorkingDir,
  translateCopilotLine,
  COPILOT_MODELS,
};
