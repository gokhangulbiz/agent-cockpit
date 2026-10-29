import { execFile, type ChildProcess } from 'child_process';
import { logger } from '../../utils/logger';

const log = logger.child({ module: 'copilot-process' });
interface Identity { pid: number; parent: number; group: number; started: string }

export class CopilotProcessScope {
  private identities = new Map<number, Identity>();
  private scanning: Promise<Identity[]> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;

  constructor(private child: ChildProcess) {
    child.once('close', () => { this.closed = true; });
    child.once('error', () => { this.closed = true; });
    if (process.platform !== 'win32' && child.pid && child.exitCode === null) {
      void this.scan();
      this.timer = setInterval(() => { void this.scan(); }, 100);
      this.timer.unref();
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      if (this.timer) clearInterval(this.timer);
      this.stopping = this.terminate().finally(() => {
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
      });
    }
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (!pid || this.child.exitCode === undefined) {
      if (!this.closed) this.child.kill('SIGTERM');
      return;
    }
    if (process.platform === 'win32') {
      if (this.closed) return;
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 2_000 }, err => {
          if (err) {
            log.warn('Copilot process-tree cleanup failed', { error: err.message });
            this.child.kill('SIGKILL');
          }
          resolve();
        });
      });
      return;
    }
    const table = await this.scan();
    if (!this.signal(table, 'SIGTERM')) {
      if (!this.closed) this.child.kill('SIGTERM');
      if (this.closed) return;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
    this.signal(await this.scan(), 'SIGKILL');
    if (!this.closed) this.child.kill('SIGKILL');
    // Pipes can remain open in a launcher even after its native child was killed.
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  private signal(table: Identity[], signal: NodeJS.Signals): boolean {
    const alive = table.filter(entry => this.identities.get(entry.pid)?.started === entry.started);
    const verifiedGroups = this.ownedGroups(table);
    const groups = new Set(alive.filter(entry => verifiedGroups.has(entry.group)).map(entry => entry.group));
    for (const group of groups) {
      try { process.kill(-group, signal); } catch { /* already exited */ }
    }
    for (const entry of alive) {
      try { process.kill(entry.pid, signal); } catch { /* already exited */ }
    }
    return alive.length > 0;
  }

  private ownedGroups(table: Identity[]): Set<number> {
    const groups = new Set<number>();
    for (const owner of this.identities.values()) {
      if (owner.pid !== owner.group) continue;
      const current = table.find(entry => entry.pid === owner.pid);
      if (!current || current.started === owner.started) groups.add(owner.group);
    }
    const root = table.find(entry => entry.pid === this.child.pid);
    const previous = this.identities.get(this.child.pid!);
    if (!root || (previous
      ? previous.started === root.started
      : !this.closed && this.child.exitCode === null)) groups.add(this.child.pid!);
    return groups;
  }

  private scan(): Promise<Identity[]> {
    if (this.scanning) return this.scanning;
    this.scanning = new Promise<Identity[]>(resolve => {
      execFile('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 500, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          log.warn('Cannot enumerate Copilot descendants', { error: err.message });
          // Each POSIX spawn owns a detached group, including npm's native child.
          if (this.stopping && !this.closed) {
            try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* already exited */ }
          }
          resolve([]);
          return;
        }
        const table = stdout.split('\n').flatMap(line => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
          return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] }] : [];
        });
        const root = table.find(entry => entry.pid === this.child.pid);
        const previous = this.identities.get(this.child.pid!);
        if (root && !this.closed && this.child.exitCode === null && (!previous || previous.started === root.started)) {
          this.identities.set(root.pid, root);
        }
        // Retain every verified group, not only the launcher's, after leader exit.
        const groups = this.ownedGroups(table);
        for (const entry of table) {
          if (groups.has(entry.group)) this.identities.set(entry.pid, entry);
        }
        // A live owned child remains a discovery root after its launcher exits.
        const owned = new Set(table.filter(entry => this.identities.get(entry.pid)?.started === entry.started).map(entry => entry.pid));
        let changed = true;
        while (changed) {
          changed = false;
          for (const entry of table) {
            if (owned.has(entry.parent) && !owned.has(entry.pid)) {
              owned.add(entry.pid);
              changed = true;
            }
          }
        }
        for (const entry of table) if (owned.has(entry.pid)) this.identities.set(entry.pid, entry);
        resolve(table);
      });
    }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
}
