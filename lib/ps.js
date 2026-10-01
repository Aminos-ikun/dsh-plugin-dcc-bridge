// Transport to the Windows desktop agent.
//
// The agent is a Windows PowerShell process that compiles its P/Invoke layer
// once and then serves requests. Three ways to reach it exist, and they are
// chosen at runtime rather than configured, because the deciding factor is a
// property of the parent process that cannot be known ahead of time:
//
//   1. `tcp`   — a loopback socket the agent listens on. Warm, one process for
//                the whole session, and unaffected by stdio restrictions.
//   2. `batch` — a one-shot `-Request/-Response` file invocation. Always works,
//                but pays the Add-Type compile on every call.
//
// `stdio: 'pipe'` is deliberately NOT used anywhere: a confined Windows parent
// fails to create the underlying anonymous pipes with EPERM, which is exactly
// the situation this module has to survive.

import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readIfExists, removeDir, runCaptured, tempDir, writeUtf8 } from './proc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(HERE, '..', 'assets', 'desktop-agent.ps1');

/** How long the agent gets to compile its native layer and accept a socket. */
const STARTUP_BUDGET_MS = 30000;
/** Bounded agent stderr kept for diagnosing a failed start. */
const DIAGNOSTIC_LIMIT = 4000;

/** Sleep helper. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Locate a PowerShell host, preferring PowerShell 7 over Windows PowerShell 5.1.
 * Either works: the agent is written for the 5.1 language level.
 * @returns the executable path to use.
 */
export function findPowerShell() {
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [];
  if (process.env.DSH_PWSH_PATH) candidates.push(process.env.DSH_PWSH_PATH);
  for (const root of [...programFiles, 'C:\\Program Files', 'C:\\Program Files (x86)']) {
    candidates.push(path.join(root, 'PowerShell', '7', 'pwsh.exe'));
    candidates.push(path.join(root, 'PowerShell', '6', 'pwsh.exe'));
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  candidates.push(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return 'powershell.exe';
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** One connect attempt with its own short deadline. */
function tryConnect(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (ok) => {
      socket.removeAllListeners();
      socket.setTimeout(0);
      if (!ok) {
        socket.destroy();
        resolve(undefined);
        return;
      }
      resolve(socket);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/**
 * A reusable desktop-agent host.
 *
 * Callers see one method, {@link DesktopHost#request}. The transport is chosen
 * on first use and only surfaces in {@link DesktopHost#transport} for
 * diagnostics.
 */
export class DesktopHost {
  #script;
  #shell;
  #transport = 'unknown';
  #transportNote;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  #child;
  /** @type {net.Socket | undefined} */
  #socket;
  #buffer = '';
  #token = '';
  /** @type {Map<string, {resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
  #pending = new Map();
  #startup;
  #batchDir;
  #stderrFile;
  #closed = false;

  /**
   * @param options - host configuration.
   * @param options.script - override the agent script path (used by tests).
   * @param options.shell - override the PowerShell executable.
   * @param options.logger - optional diagnostic sink.
   */
  constructor(options = {}) {
    this.#script = options.script ?? AGENT_SCRIPT;
    this.#shell = options.shell ?? findPowerShell();
    this.logger = options.logger;
  }

  /** The transport in use, or `unknown` before the first call. */
  get transport() {
    return this.#transport;
  }

  /** Why the preferred transport was abandoned, when it was. */
  get transportNote() {
    return this.#transportNote;
  }

  /** The PowerShell executable this host uses. */
  get shell() {
    return this.#shell;
  }

  /**
   * Perform one agent action.
   * @param action - agent action name, e.g. `screen.capture`.
   * @param params - action parameters, serialized as JSON.
   * @param options - call options: `timeoutMs` and `signal`.
   * @returns the action's `data` payload.
   */
  async request(action, params = {}, options = {}) {
    if (this.#closed) throw new Error('desktop agent host is closed');
    const timeoutMs = options.timeoutMs ?? 30000;
    if (this.#transport === 'unknown') await this.#start();
    if (this.#transport === 'tcp') {
      try {
        return await this.#requestTcp(action, params, timeoutMs, options.signal);
      } catch (error) {
        // A broken socket demotes the transport for the rest of the session; a
        // live agent reporting an action-level failure must propagate instead.
        if (this.#transport === 'tcp' && this.#socket === undefined) {
          this.#demote(error instanceof Error ? error.message : String(error));
        } else {
          throw error;
        }
      }
    }
    return this.#requestBatch(action, params, timeoutMs, options.signal);
  }

  /** Close the warm agent and release every resource. Safe to call twice. */
  dispose() {
    this.#closed = true;
    this.#socket?.destroy();
    this.#socket = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('desktop agent host closed'));
    }
    this.#pending.clear();
    if (this.#stderrFile !== undefined) {
      closeSync(this.#stderrFile.handle);
      removeDir(this.#stderrFile.dir);
      this.#stderrFile = undefined;
    }
    removeDir(this.#batchDir);
    this.#batchDir = undefined;
  }

  #demote(reason) {
    this.#transport = 'batch';
    this.#transportNote = reason;
    this.logger?.warn?.(`dcc-bridge: falling back to the one-shot desktop transport (${reason})`);
  }

  /** Start the warm agent once; every later call awaits the same attempt. */
  #start() {
    this.#startup ??= this.#startTcp();
    return this.#startup;
  }

  async #startTcp() {
    if (this.#closed) return;
    if (process.platform !== 'win32') {
      this.#demote('desktop control requires Windows');
      return;
    }

    let port;
    try {
      port = await freePort();
    } catch (error) {
      this.#demote(`no loopback port available: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.#token = randomUUID();
    // Keep the agent's stderr in a file: `stdio: 'ignore'` for stdout is fine,
    // but a failed start must still explain itself.
    const dir = tempDir('dsh-desktop-log-');
    const errPath = path.join(dir, 'agent.err');
    const errHandle = openSync(errPath, 'a');
    this.#stderrFile = { dir, path: errPath, handle: errHandle };

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.#script,
      '-Listen',
      String(port),
      '-Token',
      this.#token,
    ];

    let child;
    try {
      child = spawn(this.#shell, args, {
        stdio: ['ignore', 'ignore', errHandle],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(errHandle);
      this.#stderrFile = undefined;
      removeDir(dir);
      this.#demote(`could not start the desktop agent: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#child = child;
    child.on('error', () => {
      /* reported through the connect loop below */
    });

    const deadline = Date.now() + STARTUP_BUDGET_MS;
    while (Date.now() < deadline) {
      const socket = await tryConnect(port, 1000);
      if (socket !== undefined) {
        this.#adoptSocket(socket);
        this.#transport = 'tcp';
        return;
      }
      if (child.exitCode !== null) break;
      await delay(250);
    }

    const stderr = readIfExists(errPath).trim().split('\n').slice(-3).join(' ');
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    this.#child = undefined;
    this.#demote(
      `the desktop agent did not accept a loopback connection within ${STARTUP_BUDGET_MS}ms${
        stderr.length > 0 ? `: ${stderr}` : ''
      }`,
    );
  }

  #adoptSocket(socket) {
    this.#socket = socket;
    this.#buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onSocketData(chunk));
    socket.on('error', () => this.#onSocketGone());
    socket.on('close', () => this.#onSocketGone());
  }

  #onSocketGone() {
    if (this.#socket === undefined) return;
    this.#socket = undefined;
    const error = new Error('desktop agent connection closed');
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  #onSocketData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#settleLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #settleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = this.#pending.get(String(message.id));
    if (entry === undefined) return;
    this.#pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.data);
    else entry.reject(new Error(String(message.error ?? 'desktop agent reported failure')));
  }

  #requestTcp(action, params, timeoutMs, signal) {
    const socket = this.#socket;
    if (socket === undefined) return Promise.reject(new Error('desktop agent is not connected'));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, token: this.#token, action, params })}\n`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`desktop agent timed out after ${timeoutMs}ms handling ${action}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.write(payload, (error) => {
        if (error === undefined || error === null) return;
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error(`desktop agent write failed: ${error.message}`));
      });
    });
  }

  /** One-shot invocation whose only I/O channels are files. */
  async #requestBatch(action, params, timeoutMs, signal) {
    this.#batchDir ??= tempDir('dsh-desktop-');
    const id = randomUUID();
    const requestPath = path.join(this.#batchDir, `req-${id}.json`);
    const responsePath = path.join(this.#batchDir, `res-${id}.json`);
    writeUtf8(requestPath, JSON.stringify({ id, action, params }));
    const result = await runCaptured(
      this.#shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.#script,
        '-Request',
        requestPath,
        '-Response',
        responsePath,
      ],
      {
        // Add-Type recompiles the native layer on every cold start, so the
        // process budget is deliberately separate from the action budget.
        timeoutMs: timeoutMs + 60000,
        captureLimit: DIAGNOSTIC_LIMIT,
        onSpawn: (child) => {
          if (signal === undefined) return;
          signal.addEventListener(
            'abort',
            () => {
              try {
                child.kill();
              } catch {
                /* already gone */
              }
            },
            { once: true },
          );
        },
      },
    );
    removeDir(result.outputDir);
    if (result.timedOut) {
      throw new Error(`desktop agent timed out after ${timeoutMs}ms handling ${action}`);
    }
    const text = readIfExists(responsePath);
    if (text.length === 0) {
      const detail = (result.stderr || result.stdout || result.spawnError || '')
        .trim()
        .split('\n')
        .slice(-4)
        .join(' ');
      throw new Error(
        `desktop agent produced no response for ${action}${
          result.code === null ? '' : ` (exit code ${result.code})`
        }${detail.length > 0 ? `: ${detail}` : ''}`,
      );
    }
    const message = JSON.parse(text);
    if (message.ok !== true) throw new Error(String(message.error ?? 'desktop agent reported failure'));
    return message.data;
  }
}
