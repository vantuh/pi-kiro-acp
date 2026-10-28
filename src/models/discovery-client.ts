import { spawn, type ChildProcess } from 'node:child_process';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';

import type { AgentEngine } from '../config.ts';
import { terminateProcessTree } from '../process-utils.ts';
import { v3SpawnArgs } from '../v3/launch.ts';

type JsonRpcResponse = {
  id?: number;
  result?: any;
  error?: { message?: string; code?: number };
};

export class DiscoveryClient {
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private stderr = '';
  private readonly cwd: string;
  /** V3 needs its engine flags; its model list lives in the session's
   * configOptions instead of `models.availableModels`. */
  private readonly engine: AgentEngine;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  constructor(cwd: string, engine: AgentEngine = 'v2') {
    this.cwd = cwd;
    this.engine = engine;
  }

  async start(): Promise<void> {
    const args = this.engine === 'v3' ? v3SpawnArgs() : ['acp'];
    this.proc = spawn('kiro-cli', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });

    this.proc.on('exit', (code, signal) => {
      const error = new Error(
        `kiro-cli exited during model discovery (code=${code}, signal=${signal})${this.stderr ? `: ${this.stderr.trim()}` : ''}`,
      );
      for (const [id, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });

    this.proc.on('error', (error) => {
      for (const [id, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable)
        return reject(new Error('kiro-cli not running'));

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `model discovery RPC timeout: ${method}${this.stderr ? `: ${this.stderr.trim()}` : ''}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;

    await terminateProcessTree(proc, 2000);
    this.rl?.close();
    this.rl = null;
    this.proc = null;
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line.trim()) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(
        new Error(
          msg.error.message || `JSON-RPC error ${msg.error.code ?? 'unknown'}`,
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
  }
}
