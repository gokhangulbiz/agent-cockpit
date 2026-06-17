import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CliProfile, StreamEvent } from '../src/types';
import { CopilotAdapter, __copilotTestUtils, resolveCopilotCliRuntime } from '../src/services/backends/copilot';

const {
  buildCopilotRunArgs,
  collectCopilotJson,
  copilotLineInfo,
  copilotMcpConfig,
  canonicalCopilotToolName,
  translateCopilotLine,
  COPILOT_MODELS,
} = __copilotTestUtils;

function copilotProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  const now = '2026-06-17T00:00:00.000Z';
  return {
    id: 'profile-copilot',
    name: 'GitHub Copilot',
    harness: 'copilot',
    authMode: 'server-configured',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Copilot backend metadata', () => {
  test('advertises thinking, tool activity, and media transport', () => {
    const metadata = new CopilotAdapter().metadata;
    expect(metadata.id).toBe('copilot');
    expect(metadata.label).toBe('GitHub Copilot');
    expect(metadata.icon).toContain('<svg');
    expect(metadata.capabilities.thinking).toBe(true);
    expect(metadata.capabilities.toolActivity).toBe(true);
    expect(metadata.capabilities.planMode).toBe(false);
    expect(metadata.capabilities.agents).toBe(false);
    expect(metadata.capabilities.oneShotMediaInput).toEqual({
      image: ['explicit-attachment'],
      pdf: ['explicit-attachment'],
    });
  });

  test('exposes a curated model catalog with a default and effort levels', () => {
    expect(COPILOT_MODELS.length).toBeGreaterThan(0);
    const ids = COPILOT_MODELS.map(model => model.id);
    expect(ids).toContain('claude-sonnet-4.6');
    expect(ids).toContain('gpt-5.2');
    const defaults = COPILOT_MODELS.filter(model => model.default);
    expect(defaults).toHaveLength(1);
    for (const model of COPILOT_MODELS) {
      expect(model.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    }
  });

  test('session resume is supported while active turn resume is not', () => {
    const metadata = new CopilotAdapter().metadata;
    expect(metadata.resumeCapabilities.sessionResume).toBe('supported');
    expect(metadata.resumeCapabilities.activeTurnResume).toBe('unsupported');
  });
});

describe('resolveCopilotCliRuntime', () => {
  test('defaults to the copilot command and applies profile env', () => {
    const runtime = resolveCopilotCliRuntime(copilotProfile({ env: { FOO: 'bar', PATH: '/usr/bin:/bin' } }));
    expect(runtime.command).toContain('copilot');
    expect(runtime.env.FOO).toBe('bar');
    expect(runtime.profileKey.startsWith('profile-copilot:')).toBe(true);
  });

  test('honors a profile command override', () => {
    const runtime = resolveCopilotCliRuntime(copilotProfile({ command: '/opt/custom/copilot', env: { PATH: '/usr/bin' } }));
    expect(runtime.command).toBe('/opt/custom/copilot');
  });

  test('throws when the profile harness is not copilot', () => {
    expect(() => resolveCopilotCliRuntime(copilotProfile({ harness: 'opencode' as CliProfile['harness'] })))
      .toThrow(/not copilot/);
  });
});

describe('buildCopilotRunArgs', () => {
  test('builds non-interactive JSON args with full access for the chat path', () => {
    const args = buildCopilotRunArgs('hello world', {
      workingDir: '/tmp/workspace',
      model: 'gpt-5.2',
      effort: 'high',
      externalSessionId: 'sess-123',
      allowTools: true,
    });
    expect(args.slice(0, 8)).toEqual(['-p', 'hello world', '--output-format', 'json', '--no-ask-user', '--no-color', '--log-level', 'none']);
    expect(args).toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.2']));
    expect(args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-123']));
  });

  test('uses --allow-all-tools (not full access) for the no-tool one-shot path', () => {
    const args = buildCopilotRunArgs('summarize', { workingDir: '/tmp' });
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--resume');
  });

  test('ignores unsupported effort levels', () => {
    const args = buildCopilotRunArgs('hi', { effort: 'minimal' });
    expect(args).not.toContain('--reasoning-effort');
  });

  test('passes image and pdf attachments through --attachment', () => {
    const args = buildCopilotRunArgs('describe', {
      attachments: [
        { path: '/tmp/a.png', kind: 'image' },
        { path: '/tmp/b.pdf', kind: 'pdf' },
        { path: '/tmp/c.txt', kind: 'text' },
      ],
    });
    expect(args).toEqual(expect.arrayContaining(['--attachment', '/tmp/a.png', '--attachment', '/tmp/b.pdf']));
    expect(args).not.toContain('/tmp/c.txt');
  });

  test('emits --additional-mcp-config when MCP servers are provided', () => {
    const args = buildCopilotRunArgs('hi', {
      mcpServers: [{ name: 'agent-cockpit-memory', command: 'node', args: ['mem.js'], env: [{ name: 'TOKEN', value: 't' }] }],
    });
    const idx = args.indexOf('--additional-mcp-config');
    expect(idx).toBeGreaterThan(-1);
    const config = JSON.parse(args[idx + 1]);
    expect(config.mcpServers['agent-cockpit-memory']).toEqual({
      type: 'local',
      command: 'node',
      args: ['mem.js'],
      tools: ['*'],
      env: { TOKEN: 't' },
    });
    // MCP presence also implies broad access.
    expect(args).toContain('--allow-all');
  });
});

describe('copilotMcpConfig', () => {
  test('returns null when there are no servers', () => {
    expect(copilotMcpConfig(undefined)).toBeNull();
    expect(copilotMcpConfig([])).toBeNull();
  });
});

describe('translateCopilotLine', () => {
  test('maps assistant.message_delta to streaming text', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'assistant.message_delta',
      data: { messageId: 'm1', deltaContent: 'Hello' },
    }));
    expect(events).toEqual([{ type: 'text', content: 'Hello', streaming: true }]);
  });

  test('maps assistant.reasoning_delta to streaming thinking', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'r1', deltaContent: 'Let me think' },
    }));
    expect(events).toEqual([{ type: 'thinking', content: 'Let me think', streaming: true }]);
  });

  test('maps tool.execution_start to tool activity with a friendly description', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start',
      data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'echo hi', description: 'Echo hi' } },
    }));
    expect(events).toEqual([{ type: 'tool_activity', tool: 'Bash', id: 't1', description: 'Echo hi' }]);
  });

  test('maps a view tool to a Read activity', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_start',
      data: { toolCallId: 't2', toolName: 'view', arguments: { path: '/repo/src/app.ts' } },
    }));
    expect(events[0]).toMatchObject({ type: 'tool_activity', tool: 'Read', id: 't2' });
  });

  test('maps a successful tool.execution_complete to a success outcome', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_complete',
      data: { toolCallId: 't1', toolName: 'bash', success: true, result: { content: 'hello\n<exited with exit code 0>' } },
    }));
    expect(events).toEqual([{
      type: 'tool_outcomes',
      outcomes: [{ toolUseId: 't1', isError: false, outcome: 'exit 0', status: 'success' }],
    }]);
  });

  test('maps a failed tool.execution_complete to an error outcome', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'tool.execution_complete',
      data: { toolCallId: 't9', toolName: 'view', success: false, result: { content: 'no such file' } },
    }));
    expect(events).toEqual([{
      type: 'tool_outcomes',
      outcomes: [{ toolUseId: 't9', isError: true, outcome: 'error', status: 'error' }],
    }]);
  });

  test('maps result to an external_session event', () => {
    const events = translateCopilotLine(JSON.stringify({
      type: 'result',
      sessionId: 'sess-abc',
      exitCode: 0,
      usage: { premiumRequests: 3 },
    }));
    expect(events).toEqual([{ type: 'external_session', sessionId: 'sess-abc' }]);
  });

  test('ignores envelope and lifecycle events', () => {
    expect(translateCopilotLine(JSON.stringify({ type: 'assistant.turn_start', data: {} }))).toEqual([]);
    expect(translateCopilotLine(JSON.stringify({ type: 'session.mcp_servers_loaded', data: {} }))).toEqual([]);
    expect(translateCopilotLine('not json')).toEqual([]);
    expect(translateCopilotLine('')).toEqual([]);
  });
});

describe('copilotLineInfo', () => {
  test('extracts output tokens from assistant.message', () => {
    const info = copilotLineInfo(JSON.stringify({
      type: 'assistant.message',
      data: { messageId: 'm1', content: 'pong', outputTokens: 5 },
    }));
    expect(info.outputTokens).toBe(5);
    expect(info.isResult).toBe(false);
  });

  test('extracts sessionId and premium requests from result', () => {
    const info = copilotLineInfo(JSON.stringify({
      type: 'result',
      sessionId: 'sess-9',
      usage: { premiumRequests: 2 },
    }));
    expect(info.sessionId).toBe('sess-9');
    expect(info.premiumRequests).toBe(2);
    expect(info.isResult).toBe(true);
  });
});

describe('canonicalCopilotToolName', () => {
  test('canonicalizes copilot tool names', () => {
    expect(canonicalCopilotToolName('bash')).toBe('Bash');
    expect(canonicalCopilotToolName('view')).toBe('Read');
    expect(canonicalCopilotToolName('create')).toBe('Write');
    expect(canonicalCopilotToolName('str_replace')).toBe('Edit');
    expect(canonicalCopilotToolName('grep')).toBe('Grep');
    expect(canonicalCopilotToolName('report_intent')).toBe('Intent');
    expect(canonicalCopilotToolName('some_custom_tool')).toBe('SomeCustomTool');
  });
});

describe('collectCopilotJson', () => {
  test('reconstructs streamed text, session id, and usage from JSONL', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant.message_start', data: { messageId: 'm1' } }),
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'po' } }),
      JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'ng' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'pong', outputTokens: 5 } }),
      JSON.stringify({ type: 'result', sessionId: 'sess-xyz', exitCode: 0, usage: { premiumRequests: 3 } }),
    ].join('\n');
    const result = collectCopilotJson(stdout);
    expect(result.text).toBe('pong');
    expect(result.sessionId).toBe('sess-xyz');
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costSource: 'none',
      credits: 3,
    });
  });

  test('falls back to final message content when no deltas were streamed', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'final answer', outputTokens: 4 } }),
      JSON.stringify({ type: 'result', sessionId: 'sess-1', exitCode: 0, usage: {} }),
    ].join('\n');
    const result = collectCopilotJson(stdout);
    expect(result.text).toBe('final answer');
    expect(result.sessionId).toBe('sess-1');
  });
});

describe('CopilotAdapter working directory validation', () => {
  test('reports a missing working directory before spawning Copilot', async () => {
    const adapter = new CopilotAdapter({ workingDir: '/tmp' });
    const missing = path.join(os.tmpdir(), `copilot-missing-${Date.now()}`);
    const result = adapter.sendMessage('hello', {
      sessionId: 'session-1',
      isNewSession: true,
      workingDir: missing,
      systemPrompt: '',
    });
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'error' && /does not exist/.test((e as { error: string }).error))).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('CopilotAdapter streaming', () => {
  test('streams text, thinking, tool activity, session, and usage from the CLI JSONL', async () => {
    let streamRef!: AsyncGenerator<StreamEvent>;
    const spawnArgs: string[][] = [];
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-stream-'));

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        return {
          spawn: (_cmd: string, args: string[]) => {
            spawnArgs.push(args);
            const proc = new EventEmitter();
            proc.pid = 4242;
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.kill = () => {};
            setImmediate(() => {
              proc.stdout.write(JSON.stringify({ type: 'assistant.reasoning_delta', data: { reasoningId: 'r1', deltaContent: 'Thinking' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Hello' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'ls', description: 'List files' } } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'tool.execution_complete', data: { toolCallId: 't1', toolName: 'bash', success: true, result: { content: 'ok\n<exited with exit code 0>' } } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: 'Hello', outputTokens: 7 } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'sess-stream', exitCode: 0, usage: { premiumRequests: 1 } }) + '\n');
              proc.stdout.end();
              proc.stderr.end();
              proc.emit('close', 0, null);
            });
            return proc;
          },
        };
      });
      const { CopilotAdapter: IsolatedAdapter } = require('../src/services/backends/copilot');
      const adapter = new IsolatedAdapter({ workingDir: workdir });
      streamRef = adapter.sendMessage('hi', {
        sessionId: 'session-1',
        conversationId: 'conv-copilot',
        isNewSession: true,
        workingDir: workdir,
        systemPrompt: 'Be helpful.',
      }).stream;
    });

    const events: StreamEvent[] = [];
    for await (const event of streamRef) {
      events.push(event);
    }
    jest.dontMock('child_process');
    fs.rmSync(workdir, { recursive: true, force: true });

    expect(spawnArgs[0]).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--allow-all']));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'thinking', content: 'Thinking', streaming: true },
      { type: 'text', content: 'Hello', streaming: true },
      expect.objectContaining({ type: 'tool_activity', tool: 'Bash', id: 't1' }),
      expect.objectContaining({ type: 'tool_outcomes' }),
      { type: 'external_session', sessionId: 'sess-stream' },
      {
        type: 'usage',
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          costSource: 'none',
          credits: 1,
        },
      },
      { type: 'done' },
    ]));
  });

  test('resumes a prior session by passing --resume', async () => {
    let streamRef!: AsyncGenerator<StreamEvent>;
    const spawnArgs: string[][] = [];
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-resume-'));

    jest.isolateModules(() => {
      jest.doMock('child_process', () => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        return {
          spawn: (_cmd: string, args: string[]) => {
            spawnArgs.push(args);
            const proc = new EventEmitter();
            proc.pid = 4343;
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.kill = () => {};
            setImmediate(() => {
              proc.stdout.write(JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'again' } }) + '\n');
              proc.stdout.write(JSON.stringify({ type: 'result', sessionId: 'sess-keep', exitCode: 0, usage: {} }) + '\n');
              proc.stdout.end();
              proc.stderr.end();
              proc.emit('close', 0, null);
            });
            return proc;
          },
        };
      });
      const { CopilotAdapter: IsolatedAdapter } = require('../src/services/backends/copilot');
      const adapter = new IsolatedAdapter({ workingDir: workdir });
      streamRef = adapter.sendMessage('follow up', {
        sessionId: 'session-1',
        conversationId: 'conv-copilot-resume',
        isNewSession: false,
        externalSessionId: 'sess-keep',
        workingDir: workdir,
        systemPrompt: '',
      }).stream;
    });

    const events: StreamEvent[] = [];
    for await (const event of streamRef) {
      events.push(event);
    }
    jest.dontMock('child_process');
    fs.rmSync(workdir, { recursive: true, force: true });

    expect(spawnArgs[0]).toEqual(expect.arrayContaining(['--resume', 'sess-keep']));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'text', content: 'again', streaming: true },
      { type: 'done' },
    ]));
  });
});
