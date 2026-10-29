import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { CopilotProcessScope } from '../src/services/backends/copilotProcess';
import { BackendRegistry } from '../src/services/backends/registry';
import type { CliProfile, StreamEvent } from '../src/types';

const posix = process.platform === 'win32' ? test.skip : test;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return false;
  }
}

posix.each(['abort', 'iterator-close', 'timeout', 'signal', 'reset', 'shutdown'])(
  'reaps an npm-shaped wrapper and TERM-resistant native child on %s',
  async action => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tree-'));
    const pidFile = path.join(dir, 'native.pid');
    const launcher = path.join(dir, 'copilot');
    const childProgram = `
process.on('SIGTERM', () => {});
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({type:'assistant.message_delta',data:{messageId:'ready',deltaContent:'ready'}}));
setInterval(() => {}, 1000);
`;
    fs.writeFileSync(launcher, `#!${process.execPath}
const { spawnSync } = require('child_process');
spawnSync(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: 'inherit' });
`);
    fs.chmodSync(launcher, 0o755);
    const profile: CliProfile = {
      id: 'fixture', name: 'fixture', harness: 'copilot', authMode: 'server-configured',
      command: launcher, createdAt: '', updatedAt: '',
    };
    const backend = new CopilotAdapter({ workingDir: dir });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let childPid: number | undefined;
    try {
      const controller = new AbortController();
      const turn = backend.sendMessage('test', {
        sessionId: 'session', conversationId: 'conversation', isNewSession: true, workingDir: dir, systemPrompt: '', cliProfile: profile,
      });
      const events: StreamEvent[] = [];
      const result = action === 'timeout' || action === 'signal'
        ? backend.runOneShot('test', { cliProfile: profile, timeoutMs: action === 'timeout' ? 1_500 : 10_000, abortSignal: controller.signal })
          .then(() => null, (err: Error) => err)
        : (async () => {
          for await (const event of turn.stream) {
            events.push(event);
            if (action === 'iterator-close' && event.type === 'text') break;
          }
          return null;
        })();
      for (let i = 0; i < 100; i += 1) {
        if (fs.existsSync(pidFile)) { childPid = Number(fs.readFileSync(pidFile, 'utf8')); break; }
        await sleep(20);
      }
      expect(childPid).toBeGreaterThan(0);
      const started = Date.now();
      if (action === 'abort') turn.abort();
      if (action === 'signal') controller.abort();
      if (action === 'reset') await backend.onSessionReset('conversation');
      if (action === 'shutdown') {
        const registry = new BackendRegistry();
        registry.register(backend);
        await registry.shutdownAll();
      }
      const error = await result;
      expect(Date.now() - started).toBeLessThan(4_000);
      if (action === 'timeout') expect(error?.message).toContain('timed out');
      if (action === 'signal') expect(error?.message).toContain('aborted');
      if (['abort', 'reset', 'shutdown'].includes(action)) {
        expect(events).toEqual(expect.arrayContaining([{ type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' }]));
      }
      expect(alive(childPid!)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      await backend.shutdown();
      unrelated.kill('SIGKILL');
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

posix('tracks detached descendants after their parent exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-detached-'));
  const pidFile = path.join(dir, 'pid');
  const root = spawn(process.execPath, ['-e', `
const child = require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);
`], { detached: true, stdio: 'ignore' });
  const scope = new CopilotProcessScope(root);
  let childPid: number | undefined;
  try {
    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(pidFile)) { childPid = Number(fs.readFileSync(pidFile, 'utf8')); break; }
      await sleep(20);
    }
    expect(childPid).toBeGreaterThan(0);
    await sleep(200);
    const exit = new Promise(resolve => root.once('close', resolve));
    root.kill('SIGKILL');
    await exit;
    await scope.stop();
    expect(alive(childPid!)).toBe(false);
  } finally {
    await scope.stop();
    root.kill('SIGKILL');
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Copilot process containment edges', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    jest.dontMock('child_process');
  });

  test.each([false, true])('Windows uses bounded taskkill tree cleanup (failure=%s)', async fail => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = Object.assign(new EventEmitter(), { pid: 77, exitCode: null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    const execFile = jest.fn((_command, _args, _options, callback) => callback(fail ? new Error('taskkill failed') : null, ''));
    let Scope!: typeof CopilotProcessScope;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ execFile }));
      Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
    });
    const scope = new Scope(child as unknown as ChildProcess);
    await Promise.all([scope.stop(), scope.stop()]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '77', '/t', '/f'], expect.objectContaining({ windowsHide: true, timeout: 2_000 }), expect.any(Function));
    expect(child.kill).toHaveBeenCalledTimes(fail ? 1 : 0);
    expect(child.stdout.destroy).toHaveBeenCalled();
  });

  posix('does not signal a reused descendant PID', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '100 1 100 ROOT\n101 1 101 REUSED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
      expect(kill.mock.calls.some(call => call[0] === 101 || call[0] === -101)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('falls back to the owned group and destroys pipes when ps is unavailable', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn(), stdout: { destroy: jest.fn() } });
    const execFile = jest.fn((_command, _args, _options, callback) => callback(new Error('ps unavailable'), ''));
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGKILL');
      expect(root.kill).toHaveBeenCalledWith('SIGKILL');
      expect(root.stdout.destroy).toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  posix('contains an unobserved child that retains the owned group after launcher close', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null as number | null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n' : '101 1 100 CHILD\n200 1 200 UNRELATED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      root.exitCode = 0;
      root.emit('close');
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(kill.mock.calls.some(call => call[0] === 200 || call[0] === -200)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('contains orphan jobs in an observed child group after that child leader exits', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '100 1 100 ROOT\n102 1 101 ORPHAN\n200 1 200 UNRELATED\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-101, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(102, 'SIGKILL');
      expect(kill.mock.calls.some(call => call[0] === 200 || call[0] === -200)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  posix('discovers new detached grandchildren from tracked children after root exit', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const root = Object.assign(new EventEmitter(), { pid: 100, exitCode: null as number | null, kill: jest.fn() });
    let calls = 0;
    const execFile = jest.fn((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, calls === 1 ? '100 1 100 ROOT\n101 100 101 CHILD\n' : '101 1 101 CHILD\n102 101 102 GRANDCHILD\n');
    });
    let Scope!: typeof CopilotProcessScope;
    try {
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ execFile }));
        Scope = require('../src/services/backends/copilotProcess').CopilotProcessScope;
      });
      const scope = new Scope(root as unknown as ChildProcess);
      await sleep(0);
      root.exitCode = 1;
      root.emit('close');
      await scope.stop();
      expect(kill).toHaveBeenCalledWith(-102, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(102, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
});
